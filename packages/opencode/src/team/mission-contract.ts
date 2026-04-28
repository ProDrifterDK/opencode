import path from "node:path"
import { mkdir } from "node:fs/promises"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@/storage"
import type { SessionID } from "../session/schema"
import { decodeReviewPacket, formatReviewPacket } from "./review-packet"
import { TaskBoardTable } from "./task-board.sql"
import {
  MissionContractRevisionTable,
  MissionContractTable,
  type MissionContractID,
  type MissionContractPhase,
  type MissionContractRevisionRow,
  type MissionContractRow,
  type MissionContractStatus,
} from "./mission-contract.sql"
import type { TeamID } from "./types"

const missionContractStatuses = [
  "draft",
  "ready",
  "approved",
  "executing",
  "verification",
  "delivery_ready",
  "blocked",
  "superseded",
] as const satisfies readonly MissionContractStatus[]

const missionContractPhases = [
  "ideation",
  "design",
  "implementation",
  "verification",
  "delivery",
] as const satisfies readonly MissionContractPhase[]

const humanGateKinds = ["visual", "manual-e2e", "product-approval", "risk-approval"] as const
const humanGateRequiredBeforePhases = ["implementation", "delivery"] as const
const humanGateStatuses = ["pending", "satisfied", "waived"] as const

export type HumanGateKind = (typeof humanGateKinds)[number]
export type HumanGateRequiredBeforePhase = (typeof humanGateRequiredBeforePhases)[number]
export type HumanGateStatus = (typeof humanGateStatuses)[number]

export interface HumanGate {
  id: string
  kind: HumanGateKind
  description: string
  requiredBeforePhase: HumanGateRequiredBeforePhase
  status: HumanGateStatus
}

export interface MissionContract {
  id: MissionContractID
  teamID: TeamID
  status: MissionContractStatus
  objective: string
  successCriteria: string[]
  constraints: string[]
  nonGoals: string[]
  humanGates: HumanGate[]
  currentPhase: MissionContractPhase
  approvedAt?: number
  approvedBySessionID?: SessionID
  exportPath?: string
  timeCreated: number
  timeUpdated: number
}

export interface MissionContractRevision {
  id: string
  contractID: MissionContractID
  teamID: TeamID
  revision: number
  authorSessionID: SessionID
  reason: string
  snapshot: MissionContract
  timeCreated: number
}

export interface CreateMissionContractInput {
  teamID: TeamID
  objective: string
  successCriteria: readonly string[]
  constraints?: readonly string[]
  nonGoals?: readonly string[]
  humanGates?: readonly HumanGate[]
  authorSessionID: SessionID
}

export interface UpdateMissionContractInput {
  objective?: string
  successCriteria?: readonly string[]
  constraints?: readonly string[]
  nonGoals?: readonly string[]
  humanGates?: readonly HumanGate[]
}

export class MissionContractRepoError extends Schema.TaggedErrorClass<MissionContractRepoError>()("MissionContractRepoError", {
  code: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

type DbTransactionCallback<A> = Parameters<typeof Database.transaction<A>>[0]

const query = <A>(f: DbTransactionCallback<A>) =>
  Effect.try({
    try: () => Database.use(f),
    catch: (cause) =>
      cause instanceof MissionContractRepoError
        ? cause
        : new MissionContractRepoError({ code: "DATABASE_ERROR", message: "Database operation failed", cause }),
  })

const tx = <A>(f: DbTransactionCallback<A>) =>
  Effect.try({
    try: () => Database.transaction(f),
    catch: (cause) =>
      cause instanceof MissionContractRepoError
        ? cause
        : new MissionContractRepoError({ code: "DATABASE_ERROR", message: "Database transaction failed", cause }),
  })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isMissionContractStatus = (value: unknown): value is MissionContractStatus =>
  typeof value === "string" && missionContractStatuses.includes(value as MissionContractStatus)
const isMissionContractPhase = (value: unknown): value is MissionContractPhase =>
  typeof value === "string" && missionContractPhases.includes(value as MissionContractPhase)
const isHumanGateKind = (value: unknown): value is HumanGateKind =>
  typeof value === "string" && humanGateKinds.includes(value as HumanGateKind)
const isHumanGateRequiredBeforePhase = (value: unknown): value is HumanGateRequiredBeforePhase =>
  typeof value === "string" && humanGateRequiredBeforePhases.includes(value as HumanGateRequiredBeforePhase)
const isHumanGateStatus = (value: unknown): value is HumanGateStatus =>
  typeof value === "string" && humanGateStatuses.includes(value as HumanGateStatus)

const parseJson = <A>(raw: string, label: string, guard: (value: unknown) => value is A): A => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (guard(parsed)) return parsed
    throw new MissionContractRepoError({ code: "INVALID_JSON", message: `Invalid ${label} JSON` })
  } catch (cause) {
    if (cause instanceof MissionContractRepoError) throw cause
    throw new MissionContractRepoError({ code: "INVALID_JSON", message: `Invalid ${label} JSON`, cause })
  }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const isHumanGate = (value: unknown): value is HumanGate =>
  isRecord(value) &&
  typeof value.id === "string" &&
  isHumanGateKind(value.kind) &&
  typeof value.description === "string" &&
  isHumanGateRequiredBeforePhase(value.requiredBeforePhase) &&
  isHumanGateStatus(value.status)

const isHumanGateArray = (value: unknown): value is HumanGate[] =>
  Array.isArray(value) && value.every(isHumanGate)

export const encodeStringArray = (items: readonly string[]) => JSON.stringify([...items])
export const encodeHumanGates = (items: readonly HumanGate[]) => JSON.stringify([...items])
export const decodeStringArray = (raw: string, label: string) => parseJson(raw, label, isStringArray)
export const decodeHumanGates = (raw: string) => parseJson(raw, "human_gates", isHumanGateArray)

const rowToMissionContract = (row: MissionContractRow): MissionContract => ({
  id: row.id,
  teamID: row.team_id,
  status: row.status,
  objective: row.objective,
  successCriteria: decodeStringArray(row.success_criteria, "success_criteria"),
  constraints: decodeStringArray(row.constraints, "constraints"),
  nonGoals: decodeStringArray(row.non_goals, "non_goals"),
  humanGates: decodeHumanGates(row.human_gates),
  currentPhase: row.current_phase,
  approvedAt: row.approved_at ?? undefined,
  approvedBySessionID: row.approved_by_session_id ?? undefined,
  exportPath: row.export_path ?? undefined,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

const snapshotToRevision = (row: MissionContractRevisionRow): MissionContractRevision => ({
  id: row.id,
  contractID: row.contract_id,
  teamID: row.team_id,
  revision: row.revision,
  authorSessionID: row.author_session_id,
  reason: row.reason,
  snapshot: parseJson(row.snapshot, "revision_snapshot", isMissionContract),
  timeCreated: row.time_created,
})

const isMissionContract = (value: unknown): value is MissionContract =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.teamID === "string" &&
  isMissionContractStatus(value.status) &&
  typeof value.objective === "string" &&
  isStringArray(value.successCriteria) &&
  isStringArray(value.constraints) &&
  isStringArray(value.nonGoals) &&
  isHumanGateArray(value.humanGates) &&
  isMissionContractPhase(value.currentPhase) &&
  typeof value.timeCreated === "number" &&
  typeof value.timeUpdated === "number" &&
  (value.approvedAt === undefined || typeof value.approvedAt === "number") &&
  (value.approvedBySessionID === undefined || typeof value.approvedBySessionID === "string") &&
  (value.exportPath === undefined || typeof value.exportPath === "string")

const assertTransition = (current: MissionContractStatus, next: MissionContractStatus, contract: MissionContract) => {
  if (next === "superseded") {
    throw new MissionContractRepoError({
      code: "INVALID_TRANSITION",
      message: "Mission contract cannot transition to superseded without a replacement contract flow",
    })
  }
  if (
    (next === "ready" || next === "approved") &&
    (
      contract.objective.trim().length === 0 ||
      contract.successCriteria.length === 0 ||
      contract.humanGates.length === 0
    )
  ) {
    throw new MissionContractRepoError({
      code: "INVALID_TRANSITION",
      message: `Mission contract cannot move to ${next} without objective, success criteria, and human gates`,
    })
  }
  if (current === next) return
  const allowed: Record<MissionContractStatus, readonly MissionContractStatus[]> = {
    draft: ["ready", "approved", "blocked"],
    ready: ["approved", "blocked"],
    approved: ["executing", "blocked"],
    executing: ["verification", "blocked"],
    verification: ["delivery_ready", "blocked"],
    delivery_ready: ["blocked"],
    blocked: ["draft", "ready"],
    superseded: [],
  }
  if (!allowed[current].includes(next)) {
    throw new MissionContractRepoError({ code: "INVALID_TRANSITION", message: `Invalid mission contract status transition: ${current} -> ${next}` })
  }
}

const assertStatusPhasePair = (status: MissionContractStatus, phase: MissionContractPhase) => {
  if (status === "executing" && phase !== "implementation") {
    throw new MissionContractRepoError({ code: "INVALID_TRANSITION", message: "executing contracts must be in implementation phase" })
  }
  if (status === "verification" && phase !== "verification") {
    throw new MissionContractRepoError({ code: "INVALID_TRANSITION", message: "verification contracts must be in verification phase" })
  }
  if (status === "delivery_ready" && phase !== "delivery") {
    throw new MissionContractRepoError({ code: "INVALID_TRANSITION", message: "delivery_ready contracts must be in delivery phase" })
  }
}

const nextRevisionNumber = (db: Parameters<DbTransactionCallback<number>>[0], contractID: MissionContractID) => {
  const latest = db
    .select({ revision: MissionContractRevisionTable.revision })
    .from(MissionContractRevisionTable)
    .where(eq(MissionContractRevisionTable.contract_id, contractID))
    .orderBy(MissionContractRevisionTable.revision)
    .all()
    .at(-1)
  return (latest?.revision ?? 0) + 1
}

const revisionRow = (contract: MissionContract, revision: number, reason: string, authorSessionID: SessionID): MissionContractRevisionRow => ({
  id: crypto.randomUUID(),
  contract_id: contract.id,
  team_id: contract.teamID,
  revision,
  author_session_id: authorSessionID,
  reason,
  snapshot: JSON.stringify(contract),
  time_created: Date.now(),
})

const fetchContract = (db: Parameters<DbTransactionCallback<MissionContract | null>>[0], contractID: MissionContractID) => {
  const row = db.select().from(MissionContractTable).where(eq(MissionContractTable.id, contractID)).get()
  return row ? rowToMissionContract(row) : null
}

const fetchContractRevisions = (db: Parameters<DbTransactionCallback<MissionContractRevision[]>>[0], contractID: MissionContractID) =>
  db
    .select()
    .from(MissionContractRevisionTable)
    .where(eq(MissionContractRevisionTable.contract_id, contractID))
    .orderBy(asc(MissionContractRevisionTable.revision))
    .all()
    .map(snapshotToRevision)

const taskGraphLines = (tasks: Array<typeof TaskBoardTable.$inferSelect>) => {
  if (tasks.length === 0) return ["No tasks yet."]
  return tasks.map((task) => {
    const deps = parseJson(task.dependencies, `task ${task.id} dependencies`, isStringArray)
    const suffix = deps.length > 0 ? ` (deps: ${deps.join(", ")})` : ""
    return `- [${task.status}] ${task.title}${suffix}`
  })
}

const reviewPacketLines = (tasks: Array<typeof TaskBoardTable.$inferSelect>) => {
  const lines = tasks.flatMap((task) => {
    const packet = decodeReviewPacket(task.review_packet)
    if (!packet) return []
    const summary = formatReviewPacket(packet)
    return [`- ${task.title}`, ...summary.map((line) => `  - ${line}`)]
  })
  return lines.length > 0 ? lines : ["No review packets yet."]
}

const renderContractMarkdown = (db: Parameters<DbTransactionCallback<string>>[0], contract: MissionContract) => {
  const tasks = db
    .select()
    .from(TaskBoardTable)
    .where(eq(TaskBoardTable.team_id, contract.teamID))
    .all()
    .sort((a, b) => a.time_created - b.time_created || a.title.localeCompare(b.title))
  const revisions = fetchContractRevisions(db, contract.id)
  const gateCounts = contract.humanGates.reduce(
    (acc, gate) => {
      acc[gate.status] += 1
      return acc
    },
    { pending: 0, satisfied: 0, waived: 0 },
  )
  return [
    "# Mission overview",
    "",
    `- Team: ${contract.teamID}`,
    `- Contract ID: ${contract.id}`,
    "",
    "## Status and phase",
    "",
    `- Status: ${contract.status}`,
    `- Phase: ${contract.currentPhase}`,
    `- Human gates: ${gateCounts.pending} pending, ${gateCounts.satisfied} satisfied, ${gateCounts.waived} waived`,
    `- Export path: ${contract.exportPath ?? "not exported"}`,
    "",
    "## Objective",
    "",
    contract.objective,
    "",
    "## Success criteria",
    "",
    ...(contract.successCriteria.length > 0 ? contract.successCriteria.map((item) => `- ${item}`) : ["No success criteria."]),
    "",
    "## Constraints",
    "",
    ...(contract.constraints.length > 0 ? contract.constraints.map((item) => `- ${item}`) : ["No constraints."]),
    "",
    "## Non-goals",
    "",
    ...(contract.nonGoals.length > 0 ? contract.nonGoals.map((item) => `- ${item}`) : ["No non-goals."]),
    "",
    "## Human gates",
    "",
    ...(contract.humanGates.length > 0
      ? contract.humanGates.map((gate) => `- ${gate.id} [${gate.status}] ${gate.kind} before ${gate.requiredBeforePhase}: ${gate.description}`)
      : ["No human gates."]),
    "",
    "## Task graph summary",
    "",
    ...taskGraphLines(tasks),
    "",
    "## Review packet summary",
    "",
    ...reviewPacketLines(tasks),
    "",
    "## Revision history",
    "",
    ...(revisions.length > 0
      ? revisions.map((revision) => `- r${revision.revision} ${revision.reason} by ${revision.authorSessionID}`)
      : ["No revisions."]),
    "",
  ].join("\n")
}

export interface Interface {
  readonly create: (input: CreateMissionContractInput) => Effect.Effect<MissionContract, MissionContractRepoError>
  readonly getByTeam: (teamID: TeamID) => Effect.Effect<MissionContract | null, MissionContractRepoError>
  readonly get: (contractID: MissionContractID) => Effect.Effect<MissionContract | null, MissionContractRepoError>
  readonly update: (input: {
    contractID: MissionContractID
    patch: UpdateMissionContractInput
    reason: string
    authorSessionID: SessionID
  }) => Effect.Effect<MissionContract, MissionContractRepoError>
  readonly approve: (contractID: MissionContractID, approverSessionID: SessionID) => Effect.Effect<MissionContract, MissionContractRepoError>
  readonly setPhase: (input: {
    contractID: MissionContractID
    phase: MissionContractPhase
    status: MissionContractStatus
    reason: string
    authorSessionID: SessionID
  }) => Effect.Effect<MissionContract, MissionContractRepoError>
  readonly listRevisions: (contractID: MissionContractID) => Effect.Effect<MissionContractRevision[], MissionContractRepoError>
  readonly render: (contractOrID: MissionContract | MissionContractID) => Effect.Effect<string, MissionContractRepoError>
  readonly exportMarkdown: (contractID: MissionContractID) => Effect.Effect<{ exportPath: string; markdown: string }, MissionContractRepoError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MissionContractRepo") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const create = Effect.fn("MissionContractRepo.create")((input: CreateMissionContractInput) =>
      tx((db) => {
        const row = db
          .select()
          .from(MissionContractTable)
          .where(eq(MissionContractTable.team_id, input.teamID))
          .all()
          .find((item) => item.status !== "superseded")
        if (row) {
          throw new MissionContractRepoError({ code: "ALREADY_EXISTS", message: `Mission contract already exists for team ${input.teamID}` })
        }
        const id = crypto.randomUUID() as MissionContractID
        const now = Date.now()
        const createdRow: MissionContractRow = {
          id,
          team_id: input.teamID,
          status: "draft",
          objective: input.objective,
          success_criteria: encodeStringArray(input.successCriteria),
          constraints: encodeStringArray(input.constraints ?? []),
          non_goals: encodeStringArray(input.nonGoals ?? []),
          human_gates: encodeHumanGates(input.humanGates ?? []),
          current_phase: "ideation",
          approved_at: null,
          approved_by_session_id: null,
          export_path: null,
          time_created: now,
          time_updated: now,
        }
        db.insert(MissionContractTable).values(createdRow).run()
        const contract = rowToMissionContract(createdRow)
        db.insert(MissionContractRevisionTable).values(revisionRow(contract, 1, "create", input.authorSessionID)).run()
        return contract
      }),
    )

    const getByTeam = Effect.fn("MissionContractRepo.getByTeam")((teamID: TeamID) =>
      query((db) =>
        db
          .select()
          .from(MissionContractTable)
          .where(eq(MissionContractTable.team_id, teamID))
          .all()
          .filter((row) => row.status !== "superseded")
          .sort((a, b) => b.time_updated - a.time_updated)[0],
      ).pipe(Effect.map((row) => (row ? rowToMissionContract(row) : null))),
    )

    const get = Effect.fn("MissionContractRepo.get")((contractID: MissionContractID) =>
      query((db) => fetchContract(db, contractID)),
    )

    const writeMarkdownExport = (contract: MissionContract, exportPath: string) =>
      Effect.gen(function* () {
        const markdown = yield* query((db) => renderContractMarkdown(db, { ...contract, exportPath }))
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(path.dirname(exportPath), { recursive: true })
            await Bun.write(exportPath, markdown)
          },
          catch: (cause) => new MissionContractRepoError({ code: "EXPORT_FAILED", message: `Failed to export mission contract ${contract.id}`, cause }),
        })
        return markdown
      })

    const refreshMarkdownExport = (contract: MissionContract) =>
      contract.exportPath
        ? writeMarkdownExport(contract, contract.exportPath).pipe(Effect.map(() => contract))
        : Effect.succeed(contract)

    const update = Effect.fn("MissionContractRepo.update")((input: {
      contractID: MissionContractID
      patch: UpdateMissionContractInput
      reason: string
      authorSessionID: SessionID
    }) =>
      tx((db) => {
        const existing = fetchContract(db, input.contractID)
        if (!existing) {
          throw new MissionContractRepoError({ code: "NOT_FOUND", message: `Mission contract not found: ${input.contractID}` })
        }
        if (["executing", "verification", "delivery_ready", "superseded"].includes(existing.status)) {
          throw new MissionContractRepoError({ code: "INVALID_STATE", message: `Mission contract cannot be updated while ${existing.status}` })
        }
        const updated: MissionContract = {
          ...existing,
          objective: input.patch.objective ?? existing.objective,
          successCriteria: input.patch.successCriteria ? [...input.patch.successCriteria] : existing.successCriteria,
          constraints: input.patch.constraints ? [...input.patch.constraints] : existing.constraints,
          nonGoals: input.patch.nonGoals ? [...input.patch.nonGoals] : existing.nonGoals,
          humanGates: input.patch.humanGates ? [...input.patch.humanGates] : existing.humanGates,
          timeUpdated: Date.now(),
        }
        db.update(MissionContractTable)
          .set({
            objective: updated.objective,
            success_criteria: encodeStringArray(updated.successCriteria),
            constraints: encodeStringArray(updated.constraints),
            non_goals: encodeStringArray(updated.nonGoals),
            human_gates: encodeHumanGates(updated.humanGates),
            time_updated: updated.timeUpdated,
          })
          .where(eq(MissionContractTable.id, updated.id))
          .run()
        db.insert(MissionContractRevisionTable)
          .values(revisionRow(updated, nextRevisionNumber(db, updated.id), input.reason, input.authorSessionID))
          .run()
        return updated
      }).pipe(Effect.flatMap(refreshMarkdownExport)),
    )

    const approve = Effect.fn("MissionContractRepo.approve")((contractID: MissionContractID, approverSessionID: SessionID) =>
      tx((db) => {
        const existing = fetchContract(db, contractID)
        if (!existing) {
          throw new MissionContractRepoError({ code: "NOT_FOUND", message: `Mission contract not found: ${contractID}` })
        }
        assertTransition(existing.status, "approved", existing)
        const approvedAt = Date.now()
        const approved: MissionContract = {
          ...existing,
          status: "approved",
          currentPhase: existing.currentPhase === "ideation" ? "design" : existing.currentPhase,
          approvedAt,
          approvedBySessionID: approverSessionID,
          timeUpdated: approvedAt,
        }
        assertStatusPhasePair(approved.status, approved.currentPhase)
        db.update(MissionContractTable)
          .set({
            status: approved.status,
            current_phase: approved.currentPhase,
            approved_at: approved.approvedAt,
            approved_by_session_id: approved.approvedBySessionID,
            time_updated: approved.timeUpdated,
          })
          .where(eq(MissionContractTable.id, contractID))
          .run()
        db.insert(MissionContractRevisionTable)
          .values(revisionRow(approved, nextRevisionNumber(db, approved.id), "approve", approverSessionID))
          .run()
        return approved
      }).pipe(Effect.flatMap(refreshMarkdownExport)),
    )

    const setPhase = Effect.fn("MissionContractRepo.setPhase")((input: {
      contractID: MissionContractID
      phase: MissionContractPhase
      status: MissionContractStatus
      reason: string
      authorSessionID: SessionID
    }) =>
      tx((db) => {
        const existing = fetchContract(db, input.contractID)
        if (!existing) {
          throw new MissionContractRepoError({ code: "NOT_FOUND", message: `Mission contract not found: ${input.contractID}` })
        }
        assertTransition(existing.status, input.status, existing)
        assertStatusPhasePair(input.status, input.phase)
        const updated: MissionContract = {
          ...existing,
          status: input.status,
          currentPhase: input.phase,
          timeUpdated: Date.now(),
        }
        db.update(MissionContractTable)
          .set({ status: updated.status, current_phase: updated.currentPhase, time_updated: updated.timeUpdated })
          .where(eq(MissionContractTable.id, updated.id))
          .run()
        db.insert(MissionContractRevisionTable)
          .values(revisionRow(updated, nextRevisionNumber(db, updated.id), input.reason, input.authorSessionID))
          .run()
        return updated
      }).pipe(Effect.flatMap(refreshMarkdownExport)),
    )

    const listRevisions = Effect.fn("MissionContractRepo.listRevisions")((contractID: MissionContractID) =>
      query((db) => fetchContractRevisions(db, contractID)),
    )

    const render = Effect.fn("MissionContractRepo.render")((contractOrID: MissionContract | MissionContractID) =>
      query((db) => {
        const contract = typeof contractOrID === "string" ? fetchContract(db, contractOrID) : contractOrID
        if (!contract) {
          throw new MissionContractRepoError({ code: "NOT_FOUND", message: `Mission contract not found: ${contractOrID}` })
        }
        return renderContractMarkdown(db, contract)
      }),
    )

    const exportMarkdown = Effect.fn("MissionContractRepo.exportMarkdown")((contractID: MissionContractID) =>
      Effect.gen(function* () {
        const contract = yield* get(contractID)
        if (!contract) {
          return yield* new MissionContractRepoError({ code: "NOT_FOUND", message: `Mission contract not found: ${contractID}` })
        }
        const exportPath = path.join(".tmp", "team", contract.teamID, "mission.md")
        const markdown = yield* writeMarkdownExport(contract, exportPath)
        yield* query((db) =>
          db.update(MissionContractTable)
            .set({ export_path: exportPath, time_updated: Date.now() })
            .where(eq(MissionContractTable.id, contractID))
            .run(),
        )
        return { exportPath, markdown }
      }),
    )

    return Service.of({ create, getByTeam, get, update, approve, setPhase, listRevisions, render, exportMarkdown })
  }),
)

export const defaultLayer = layer

export * as MissionContractRepo from "./mission-contract"
