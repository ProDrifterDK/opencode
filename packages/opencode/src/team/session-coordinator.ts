import { eq } from "drizzle-orm"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage"
import { Service as SessionService, defaultLayer as sessionDefaultLayer } from "@/session/session"
import { Service as MailboxService, defaultLayer as mailboxDefaultLayer } from "./mailbox"
import { Service as TaskBoardService, layer as taskBoardLayer } from "./task-board"
import { TeamStateTable, EngineerSlotTable } from "./session-coordinator.sql"
import { TeamID, EngineerID, type EngineerState } from "./types"
import { MAX_TEAM_SIZE } from "./constants"
import { Event, publishTeamEvent } from "./events"
import type { SessionID } from "../session/schema"

export class CoordinatorError extends Schema.TaggedErrorClass<CoordinatorError>()("CoordinatorError", {
  message: Schema.String,
}) {}

export interface EngineerSlot {
  engineerID: EngineerID
  teamID: TeamID
  sessionID: SessionID
  name: string
  state: EngineerState
  currentTask: string | null
  startedAt: number | null
  lastHeartbeat: number
}

export interface TeamRecord {
  teamID: TeamID
  state: "idle" | "active" | "dissolving"
  leadSessionID: SessionID
  engineerCount: number
  createdAt: number
  updatedAt: number
}

export interface Interface {
  readonly createTeam: (input: {
    teamID: TeamID
    leadSessionID: SessionID
    goal?: string
  }) => Effect.Effect<TeamRecord, CoordinatorError>
  readonly spawnEngineer: (input: {
    teamID: TeamID
    leadSessionID: SessionID
    name?: string
  }) => Effect.Effect<EngineerSlot, CoordinatorError>
  readonly resumeEngineer: (input: {
    engineerID: EngineerID
    taskID: string
  }) => Effect.Effect<EngineerSlot, CoordinatorError>
  readonly killEngineer: (input: {
    engineerID: EngineerID
    teamID: TeamID
  }) => Effect.Effect<void, CoordinatorError>
  readonly dissolveTeam: (input: {
    teamID: TeamID
  }) => Effect.Effect<void, CoordinatorError>
  readonly getTeam: (teamID: TeamID) => Effect.Effect<TeamRecord | null, CoordinatorError>
  readonly getEngineer: (engineerID: EngineerID) => Effect.Effect<EngineerSlot | null, CoordinatorError>
  readonly listTeamEngineers: (teamID: TeamID) => Effect.Effect<EngineerSlot[], CoordinatorError>
  readonly listTeams: () => Effect.Effect<TeamRecord[], CoordinatorError>
  readonly isLead: (sessionID: SessionID) => Effect.Effect<boolean, CoordinatorError>
  readonly isEngineer: (sessionID: SessionID) => Effect.Effect<boolean, CoordinatorError>
  readonly getEngineerBySession: (sessionID: SessionID) => Effect.Effect<EngineerSlot | null, CoordinatorError>
  readonly updateEngineer: (engineerID: EngineerID, updates: {
    state?: EngineerState
    currentTask?: string | null
    lastHeartbeat?: number
  }) => Effect.Effect<EngineerSlot, CoordinatorError>
  readonly getTeamForSession: (sessionID: SessionID) => Effect.Effect<TeamID | null, CoordinatorError>
}

type DbClient = Parameters<typeof Database.use>[0] extends (db: infer T) => unknown ? T : never
type NotPromise<T> = T extends Promise<any> ? never : T

function dbQuery<A>(f: (db: DbClient) => NotPromise<A>) {
  return Effect.try({ try: () => Database.use(f), catch: (cause) => new CoordinatorError({ message: String(cause) }) })
}

function dbTx<A>(f: (db: DbClient) => NotPromise<A>) {
  return Effect.try({ try: () => Database.transaction(f), catch: (cause) => new CoordinatorError({ message: String(cause) }) })
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCoordinator") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* SessionService
    const mailbox = yield* MailboxService
    const taskBoard = yield* TaskBoardService

    const teams = new Map<TeamID, TeamRecord>()
    const engineers = new Map<EngineerID, EngineerSlot>()

    const hydrateFromDb = Effect.fnUntraced(function* () {
      const teamRows = yield* dbQuery((db) =>
        db.select().from(TeamStateTable).all(),
      )
      for (const row of teamRows) {
        teams.set(row.team_id, {
          teamID: row.team_id,
          state: row.state,
          leadSessionID: row.lead_session_id,
          engineerCount: row.engineer_count,
          createdAt: row.time_created,
          updatedAt: row.time_updated,
        })
      }

      const engRows = yield* dbQuery((db) =>
        db.select().from(EngineerSlotTable).all(),
      )
      for (const row of engRows) {
        engineers.set(row.id, {
          engineerID: row.id,
          teamID: row.team_id,
          sessionID: row.session_id,
          name: row.name,
          state: row.state as EngineerState,
          currentTask: row.current_task,
          startedAt: row.started_at,
          lastHeartbeat: row.last_heartbeat,
        })
      }
    })

    yield* hydrateFromDb()

    const createTeam = Effect.fn("SessionCoordinator.createTeam")(function* (input: {
      teamID: TeamID
      leadSessionID: SessionID
      goal?: string
    }) {
      if (teams.has(input.teamID)) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team already exists: ${input.teamID}` }))
      }

      const now = Date.now()
      const record: TeamRecord = {
        teamID: input.teamID,
        state: "idle",
        leadSessionID: input.leadSessionID,
        engineerCount: 0,
        createdAt: now,
        updatedAt: now,
      }

      yield* dbTx((db) => {
        db.insert(TeamStateTable).values({
          team_id: record.teamID as any,
          state: record.state,
          lead_session_id: record.leadSessionID as any,
          engineer_count: record.engineerCount,
          time_created: now,
          time_updated: now,
        }).run()
      })

      teams.set(input.teamID, record)

      void publishTeamEvent(Event.TeamCreated, {
        teamID: input.teamID,
        leadSessionID: input.leadSessionID,
        goal: input.goal ?? "",
      })

      return record
    })

    const spawnEngineer = Effect.fn("SessionCoordinator.spawnEngineer")(function* (input: {
      teamID: TeamID
      leadSessionID: SessionID
      name?: string
    }) {
      const team = teams.get(input.teamID)
      if (!team) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team not found: ${input.teamID}` }))
      }

      const teamEngineers = [...engineers.values()].filter((e) => e.teamID === input.teamID)
      if (teamEngineers.length >= MAX_TEAM_SIZE) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team ${input.teamID} has reached max size (${MAX_TEAM_SIZE})` }))
      }

      const sessionInfo = yield* session.create({
        parentID: input.leadSessionID,
        title: `Engineer session (@engineer subagent)`,
      })

      const engineerID = EngineerID.ascending() as EngineerID
      const now = Date.now()
      const engName = input.name ?? `engineer-${teamEngineers.length + 1}`

      const slot: EngineerSlot = {
        engineerID,
        teamID: input.teamID,
        sessionID: sessionInfo.id,
        name: engName,
        state: "idle",
        currentTask: null,
        startedAt: now,
        lastHeartbeat: now,
      }

      yield* dbTx((db) => {
        db.insert(EngineerSlotTable).values({
          id: slot.engineerID,
          team_id: slot.teamID,
          session_id: slot.sessionID,
          name: slot.name,
          state: slot.state,
          current_task: slot.currentTask,
          started_at: slot.startedAt,
          last_heartbeat: slot.lastHeartbeat,
          time_created: now,
          time_updated: now,
        }).run()

        db.update(TeamStateTable)
          .set({
            engineer_count: teamEngineers.length + 1,
            state: "active",
            time_updated: now,
          })
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })

      engineers.set(engineerID, slot)
      team.engineerCount = teamEngineers.length + 1
      team.state = "active"
      team.updatedAt = now

      void publishTeamEvent(Event.EngineerSpawned, {
        teamID: input.teamID,
        engineerID,
        name: engName,
        taskId: slot.currentTask,
      })

      return slot
    })

    const resumeEngineer = Effect.fn("SessionCoordinator.resumeEngineer")(function* (input: {
      engineerID: EngineerID
      taskID: string
    }) {
      const slot = engineers.get(input.engineerID)
      if (!slot) {
        return yield* Effect.fail(new CoordinatorError({ message: `Engineer not found: ${input.engineerID}` }))
      }

      const existing = yield* session.get(input.taskID as SessionID).pipe(
        Effect.catchCause(() => Effect.fail(new CoordinatorError({ message: `Session ${input.taskID} not found for resume` }))),
      )

      const now = Date.now()
      const updated: EngineerSlot = {
        ...slot,
        sessionID: existing.id,
        state: "idle",
        lastHeartbeat: now,
      }

      yield* dbTx((db) => {
        db.update(EngineerSlotTable)
          .set({
            session_id: updated.sessionID,
            state: updated.state,
            last_heartbeat: now,
            time_updated: now,
          })
          .where(eq(EngineerSlotTable.id, input.engineerID))
          .run()
      })

      engineers.set(input.engineerID, updated)
      return updated
    })

    const killEngineer = Effect.fn("SessionCoordinator.killEngineer")(function* (input: {
      engineerID: EngineerID
      teamID: TeamID
    }) {
      const slot = engineers.get(input.engineerID)
      if (!slot) {
        return yield* Effect.fail(new CoordinatorError({ message: `Engineer not found: ${input.engineerID}` }))
      }

      yield* session.remove(slot.sessionID).pipe(
        Effect.catchCause(() => Effect.void),
      )

      yield* mailbox.purge(slot.sessionID).pipe(
        Effect.catchCause(() => Effect.void),
      )

      const now = Date.now()
      yield* dbTx((db) => {
        db.delete(EngineerSlotTable)
          .where(eq(EngineerSlotTable.id, input.engineerID))
          .run()

        const remaining = [...engineers.values()].filter(
          (e) => e.teamID === input.teamID && e.engineerID !== input.engineerID,
        )
        db.update(TeamStateTable)
          .set({
            engineer_count: remaining.length,
            state: remaining.length === 0 ? "idle" : "active",
            time_updated: now,
          })
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })

      engineers.delete(input.engineerID)

      const team = teams.get(input.teamID)
      if (team) {
        team.engineerCount = Math.max(0, team.engineerCount - 1)
        if (team.engineerCount === 0) team.state = "idle"
        team.updatedAt = now
      }

      void publishTeamEvent(Event.EngineerFailed, {
        teamID: input.teamID,
        engineerID: input.engineerID,
        taskId: slot.currentTask ?? "unknown",
        error: "killed by coordinator",
      })
    })

    const dissolveTeam = Effect.fn("SessionCoordinator.dissolveTeam")(function* (input: {
      teamID: TeamID
    }) {
      const team = teams.get(input.teamID)
      if (!team) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team not found: ${input.teamID}` }))
      }

      yield* dbTx((db) => {
        db.update(TeamStateTable)
          .set({ state: "dissolving", time_updated: Date.now() })
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })
      team.state = "dissolving"

      const teamEngineers = [...engineers.values()].filter((e) => e.teamID === input.teamID)

      for (const eng of teamEngineers) {
        yield* session.remove(eng.sessionID).pipe(
          Effect.catchCause(() => Effect.void),
        )

        yield* mailbox.purge(eng.sessionID).pipe(
          Effect.catchCause(() => Effect.void),
        )

        engineers.delete(eng.engineerID)
      }

      const allTasks = yield* taskBoard.list({ team_id: input.teamID }).pipe(
        Effect.catchCause(() => Effect.succeed([] as any[])),
      )
      for (const task of allTasks) {
        yield* taskBoard.delete(task.id).pipe(
          Effect.catchCause(() => Effect.void),
        )
      }

      yield* dbTx((db) => {
        db.delete(EngineerSlotTable)
          .where(eq(EngineerSlotTable.team_id, input.teamID))
          .run()
        db.delete(TeamStateTable)
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })

      teams.delete(input.teamID)

      void publishTeamEvent(Event.TeamDissolved, {
        teamID: input.teamID,
        reason: "dissolved by lead",
      })
    })

    const getTeam = Effect.fn("SessionCoordinator.getTeam")((teamID: TeamID) =>
      Effect.sync(() => teams.get(teamID) ?? null),
    )

    const getEngineer = Effect.fn("SessionCoordinator.getEngineer")((engineerID: EngineerID) =>
      Effect.sync(() => engineers.get(engineerID) ?? null),
    )

    const listTeamEngineers = Effect.fn("SessionCoordinator.listTeamEngineers")((teamID: TeamID) =>
      Effect.sync(() => [...engineers.values()].filter((e) => e.teamID === teamID)),
    )

    const listTeams = Effect.fn("SessionCoordinator.listTeams")(() =>
      Effect.sync(() => [...teams.values()].map((t) => ({
        teamID: t.teamID,
        state: t.state,
        leadSessionID: t.leadSessionID,
        engineerCount: t.engineerCount,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }))),
    )

    const isLead = Effect.fn("SessionCoordinator.isLead")((sessionID: SessionID) =>
      Effect.sync(() => [...teams.values()].some((t) => t.leadSessionID === sessionID)),
    )

    const isEngineer = Effect.fn("SessionCoordinator.isEngineer")((sessionID: SessionID) =>
      Effect.sync(() => [...engineers.values()].some((e) => e.sessionID === sessionID)),
    )

    const getEngineerBySession = Effect.fn("SessionCoordinator.getEngineerBySession")((sessionID: SessionID) =>
      Effect.sync(() => [...engineers.values()].find((e) => e.sessionID === sessionID) ?? null),
    )

    const getTeamForSession = Effect.fn("SessionCoordinator.getTeamForSession")((sessionID: SessionID) =>
      Effect.sync(() => {
        const asLead = [...teams.values()].find((t) => t.leadSessionID === sessionID)
        if (asLead) return asLead.teamID
        const asEngineer = [...engineers.values()].find((e) => e.sessionID === sessionID)
        if (asEngineer) return asEngineer.teamID
        return null
      }),
    )

    const updateEngineer = Effect.fn("SessionCoordinator.updateEngineer")(function* (
      engineerID: EngineerID,
      updates: { state?: EngineerState; currentTask?: string | null; lastHeartbeat?: number },
    ) {
      const slot = engineers.get(engineerID)
      if (!slot) {
        return yield* Effect.fail(new CoordinatorError({ message: `Engineer not found: ${engineerID}` }))
      }

      const now = Date.now()
      const updated: EngineerSlot = {
        ...slot,
        ...(updates.state !== undefined ? { state: updates.state } : {}),
        ...(updates.currentTask !== undefined ? { currentTask: updates.currentTask } : {}),
        lastHeartbeat: updates.lastHeartbeat ?? now,
      }

      yield* dbTx((db) => {
        db.update(EngineerSlotTable)
          .set({
            ...(updates.state !== undefined ? { state: updates.state } : {}),
            ...(updates.currentTask !== undefined ? { current_task: updates.currentTask } : {}),
            last_heartbeat: updated.lastHeartbeat,
            time_updated: now,
          })
          .where(eq(EngineerSlotTable.id, engineerID))
          .run()
      })

      engineers.set(engineerID, updated)
      return updated
    })

    return Service.of({
      createTeam,
      spawnEngineer,
      resumeEngineer,
      killEngineer,
      dissolveTeam,
      getTeam,
      getEngineer,
      listTeamEngineers,
      listTeams,
      isLead,
      isEngineer,
      getEngineerBySession,
      updateEngineer,
      getTeamForSession,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(mailboxDefaultLayer),
  Layer.provide(taskBoardLayer),
  Layer.provide(sessionDefaultLayer),
)

export * as SessionCoordinator from "./session-coordinator"
