import path from "node:path"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { beforeAll, beforeEach, afterAll, describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { buildReviewPacket, encodeReviewPacket } from "./review-packet"

type MissionModule = typeof import("./mission-contract")
type MissionSqlModule = typeof import("./mission-contract.sql")
type DbModule = typeof import("../storage/db")
type SessionCoordinatorSqlModule = typeof import("./session-coordinator.sql")
type TaskBoardSqlModule = typeof import("./task-board.sql")
type TeamID = SessionCoordinatorSqlModule["TeamStateTable"]["$inferInsert"]["team_id"]
type SessionID = SessionCoordinatorSqlModule["TeamStateTable"]["$inferInsert"]["lead_session_id"]
type MissionContractID = MissionSqlModule["MissionContractTable"]["$inferInsert"]["id"]
type TaskBoardID = TaskBoardSqlModule["TaskBoardTable"]["$inferInsert"]["id"]

const dbPath = path.join(import.meta.dir, "..", "..", ".tmp", "mission-contract.test.sqlite")
const exportRoot = path.join(process.cwd(), ".tmp", "team")
const sessionLead = "session_lead" as SessionID

process.env.OPENCODE_DB = dbPath

let mission: MissionModule
let missionSql: MissionSqlModule
let database: DbModule
let sessionCoordinatorSql: SessionCoordinatorSqlModule
let taskBoardSql: TaskBoardSqlModule

const loadModules = async () => {
  mission = await import("./mission-contract")
  missionSql = await import("./mission-contract.sql")
  database = await import("../storage/db")
  sessionCoordinatorSql = await import("./session-coordinator.sql")
  taskBoardSql = await import("./task-board.sql")
}

const ensureMissionTables = () =>
  database.use((db) => {
    db.run(sql.raw(`
      create table if not exists mission_contract (
        id text primary key not null,
        team_id text not null references team_state(team_id) on delete cascade,
        status text not null,
        objective text not null,
        success_criteria text not null default '[]',
        constraints text not null default '[]',
        non_goals text not null default '[]',
        human_gates text not null default '[]',
        current_phase text not null,
        approved_at integer,
        approved_by_session_id text,
        export_path text,
        time_created integer not null,
        time_updated integer not null
      )
    `))
    db.run(sql.raw(`create index if not exists mission_contract_team_id_idx on mission_contract(team_id)`))
    db.run(sql.raw(`create index if not exists mission_contract_status_idx on mission_contract(status)`))
    db.run(sql.raw(`
      create table if not exists mission_contract_revision (
        id text primary key not null,
        contract_id text not null references mission_contract(id) on delete cascade,
        team_id text not null references team_state(team_id) on delete cascade,
        revision integer not null,
        author_session_id text not null,
        reason text not null,
        snapshot text not null,
        time_created integer not null
      )
    `))
    db.run(sql.raw(`create index if not exists mission_contract_revision_contract_id_idx on mission_contract_revision(contract_id)`))
    db.run(sql.raw(`create index if not exists mission_contract_revision_team_id_idx on mission_contract_revision(team_id)`))
    db.run(sql.raw(`create unique index if not exists mission_contract_revision_contract_id_revision_idx on mission_contract_revision(contract_id, revision)`))
  })

const resetTables = () =>
  database.use((db) => {
    db.delete(missionSql.MissionContractRevisionTable).run()
    db.delete(missionSql.MissionContractTable).run()
    db.delete(taskBoardSql.TaskBoardTable).run()
    db.delete(sessionCoordinatorSql.TeamStateTable).run()
  })

const seedTeam = (teamID = "team_test" as TeamID) => {
  const now = Date.now()
  database.use((db) => {
    db.insert(sessionCoordinatorSql.TeamStateTable).values({
      team_id: teamID,
      state: "idle",
      lead_session_id: sessionLead,
      engineer_count: 0,
      time_created: now,
      time_updated: now,
    }).run()
  })
  return teamID
}

const runRepo = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect as Effect.Effect<A, E, never>, mission.layer as never)) as Promise<A>

const createContract = (teamID = seedTeam()) =>
  runRepo(
    Effect.gen(function* () {
      const repo = yield* mission.Service
      return yield* repo.create({
        teamID,
        objective: "Ship mission contract repo",
        successCriteria: ["repo implemented", "tests passing"],
        constraints: ["no any"],
        nonGoals: ["no tool wiring yet"],
        humanGates: [{
          id: "gate_visual",
          kind: "visual",
          description: "Manual UX sweep",
          requiredBeforePhase: "delivery",
          status: "pending",
        }],
        authorSessionID: sessionLead,
      })
    }),
  )

beforeAll(async () => {
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  await loadModules()
  ensureMissionTables()
})

beforeEach(() => {
  resetTables()
  rmSync(exportRoot, { recursive: true, force: true })
})

afterAll(() => {
  database.close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(exportRoot, { recursive: true, force: true })
})

describe("MissionContract schema", () => {
  test("accepts minimum mission contract and revision rows", () => {
    const teamID = seedTeam("team_schema" as TeamID)
    const now = Date.now()
    const contractID = "contract_schema" as MissionContractID

    database.use((db) => {
      db.insert(missionSql.MissionContractTable).values({
        id: contractID,
        team_id: teamID,
        status: "draft",
        objective: "Schema contract",
        success_criteria: "[\"one\"]",
        constraints: "[]",
        non_goals: "[]",
        human_gates: "[]",
        current_phase: "ideation",
        approved_at: null,
        approved_by_session_id: null,
        export_path: null,
        time_created: now,
        time_updated: now,
      }).run()
      db.insert(missionSql.MissionContractRevisionTable).values({
        id: "rev_schema",
        contract_id: contractID,
        team_id: teamID,
        revision: 1,
        author_session_id: sessionLead,
        reason: "create",
        snapshot: "{}",
        time_created: now,
      }).run()
    })

    const rows = database.use((db) => ({
      contracts: db.select().from(missionSql.MissionContractTable).all(),
      revisions: db.select().from(missionSql.MissionContractRevisionTable).all(),
    }))

    expect(rows.contracts).toHaveLength(1)
    expect(rows.contracts[0]?.export_path).toBeNull()
    expect(rows.revisions).toHaveLength(1)
    expect(rows.revisions[0]?.contract_id).toBe(contractID)
  })

  test("creates unique revision index for contract revision pairs", () => {
    const index = database.Client().$client
      .prepare(`select sql from sqlite_master where type = 'index' and name = 'mission_contract_revision_contract_id_revision_idx'`)
      .get() as { sql: string } | null
    const columns = database.Client().$client
      .prepare(`pragma index_info('mission_contract_revision_contract_id_revision_idx')`)
      .all() as { seqno: number; name: string }[]

    expect(index?.sql.toLowerCase()).toContain("create unique index")
    expect(index?.sql.toLowerCase()).toContain("mission_contract_revision_contract_id_revision_idx")
    expect(columns.map((column) => column.name)).toEqual(["contract_id", "revision"])
  })
})

describe("MissionContractRepo helpers and lifecycle", () => {
  test("round-trips JSON helpers and rejects malformed gates", () => {
    const encoded = mission.encodeHumanGates([{ id: "gate_1", kind: "visual", description: "Check", requiredBeforePhase: "delivery", status: "pending" }])
    expect(mission.decodeHumanGates(encoded)).toEqual([{ id: "gate_1", kind: "visual", description: "Check", requiredBeforePhase: "delivery", status: "pending" }])
    expect(mission.decodeStringArray(mission.encodeStringArray(["a", "b"]), "criteria")).toEqual(["a", "b"])
    expect(() => mission.decodeHumanGates('[{"id":1}]')).toThrow("Invalid human_gates JSON")
  })

  test("create and getByTeam create revision 1 and return latest active contract", async () => {
    const teamID = seedTeam("team_create" as TeamID)
    const contract = await createContract(teamID)

    const result = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return {
          latest: yield* repo.getByTeam(teamID),
          revisions: yield* repo.listRevisions(contract.id),
        }
      }),
    )

    expect(result.latest?.id).toBe(contract.id)
    expect(result.latest?.status).toBe("draft")
    expect(result.revisions.map((revision) => revision.revision)).toEqual([1])
    expect(result.revisions[0]?.reason).toBe("create")
  })

  test("update records revision and approve/setPhase follow allowed transitions", async () => {
    const contract = await createContract(seedTeam("team_update" as TeamID))

    const result = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        const updated = yield* repo.update({
          contractID: contract.id,
          patch: {
            objective: "Updated objective",
            successCriteria: ["repo implemented", "tests passing", "export works"],
          },
          reason: "refine objective",
          authorSessionID: sessionLead,
        })
        const approved = yield* repo.approve(updated.id, sessionLead)
        const executing = yield* repo.setPhase({
          contractID: approved.id,
          phase: "implementation",
          status: "executing",
          reason: "spawn engineers",
          authorSessionID: sessionLead,
        })
        return {
          updated,
          approved,
          executing,
          revisions: yield* repo.listRevisions(contract.id),
        }
      }),
    )

    expect(result.updated.objective).toBe("Updated objective")
    expect(result.approved.status).toBe("approved")
    expect(result.approved.approvedBySessionID).toBe(sessionLead)
    expect(result.executing.currentPhase).toBe("implementation")
    expect(result.revisions.map((revision) => revision.reason)).toEqual(["create", "refine objective", "approve", "spawn engineers"])
  })

  test("draft to ready rejects blank objective and absent human gates", async () => {
    const withoutGates = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.create({
          teamID: seedTeam("team_ready_without_gates" as TeamID),
          objective: "Valid objective",
          successCriteria: ["one criterion"],
          humanGates: [],
          authorSessionID: sessionLead,
        })
      }),
    )

    const blankObjective = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.create({
          teamID: seedTeam("team_ready_blank_objective" as TeamID),
          objective: "   ",
          successCriteria: ["one criterion"],
          humanGates: [{
            id: "gate_ready",
            kind: "manual-e2e",
            description: "Run manual check",
            requiredBeforePhase: "delivery",
            status: "pending",
          }],
          authorSessionID: sessionLead,
        })
      }),
    )

    await expect(runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.setPhase({
          contractID: withoutGates.id,
          phase: "design",
          status: "ready",
          reason: "attempt ready",
          authorSessionID: sessionLead,
        })
      }),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" })

    await expect(runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.setPhase({
          contractID: blankObjective.id,
          phase: "design",
          status: "ready",
          reason: "attempt ready",
          authorSessionID: sessionLead,
        })
      }),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  })

  test("approve rejects incomplete draft contracts", async () => {
    const withoutGates = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.create({
          teamID: seedTeam("team_approve_without_gates" as TeamID),
          objective: "Valid objective",
          successCriteria: ["one criterion"],
          humanGates: [],
          authorSessionID: sessionLead,
        })
      }),
    )
    const withoutCriteria = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.create({
          teamID: seedTeam("team_approve_without_criteria" as TeamID),
          objective: "Valid objective",
          successCriteria: [],
          humanGates: [{
            id: "gate_approve",
            kind: "manual-e2e",
            description: "Run manual check",
            requiredBeforePhase: "delivery",
            status: "pending",
          }],
          authorSessionID: sessionLead,
        })
      }),
    )

    await expect(runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.approve(withoutGates.id, sessionLead)
      }),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
    await expect(runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.approve(withoutCriteria.id, sessionLead)
      }),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  })

  test("draft to ready accepts trimmed objective, criteria, and human gates", async () => {
    const contract = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.create({
          teamID: seedTeam("team_ready_valid" as TeamID),
          objective: "  Ready objective  ",
          successCriteria: ["criterion"],
          humanGates: [{
            id: "gate_ready_valid",
            kind: "visual",
            description: "Visual check",
            requiredBeforePhase: "delivery",
            status: "pending",
          }],
          authorSessionID: sessionLead,
        })
      }),
    )

    const ready = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.setPhase({
          contractID: contract.id,
          phase: "design",
          status: "ready",
          reason: "requirements satisfied",
          authorSessionID: sessionLead,
        })
      }),
    )

    expect(ready.status).toBe("ready")
    expect(ready.currentPhase).toBe("design")
  })

  test("rejects invalid transitions without partial revisions", async () => {
    const contract = await createContract(seedTeam("team_invalid" as TeamID))
    await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.approve(contract.id, sessionLead)
      }),
    )

    const result = runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.setPhase({
          contractID: contract.id,
          phase: "delivery",
          status: "delivery_ready",
          reason: "skip ahead",
          authorSessionID: sessionLead,
        })
      }),
    )

    await expect(result).rejects.toMatchObject({ code: "INVALID_TRANSITION" })

    const revisions = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.listRevisions(contract.id)
      }),
    )

    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2])
  })

  test("rejects superseded via ordinary setPhase", async () => {
    const contract = await createContract(seedTeam("team_superseded" as TeamID))

    await expect(runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.setPhase({
          contractID: contract.id,
          phase: "design",
          status: "superseded",
          reason: "replace later",
          authorSessionID: sessionLead,
        })
      }),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  })

  test("typed JSON decode error surfaces through repo reads", async () => {
    const teamID = seedTeam("team_bad_json" as TeamID)
    const now = Date.now()
    const contractID = "contract_bad_json" as MissionContractID

    database.use((db) => {
      db.insert(missionSql.MissionContractTable).values({
        id: contractID,
        team_id: teamID,
        status: "draft",
        objective: "Broken json",
        success_criteria: "[\"one\"]",
        constraints: "[]",
        non_goals: "[]",
        human_gates: '{"bad":true}',
        current_phase: "ideation",
        approved_at: null,
        approved_by_session_id: null,
        export_path: null,
        time_created: now,
        time_updated: now,
      }).run()
    })

    const result = runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.get(contractID)
      }),
    )

    await expect(result).rejects.toMatchObject({ code: "INVALID_JSON" })
  })

  test("render is deterministic and exportMarkdown stores export path", async () => {
    const teamID = seedTeam("team_render" as TeamID)
    const contract = await createContract(teamID)

    await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        yield* repo.update({
          contractID: contract.id,
          patch: { constraints: ["no any", "no docs edits"] },
          reason: "tighten constraints",
          authorSessionID: sessionLead,
        })
        yield* repo.approve(contract.id, sessionLead)
      }),
    )

    database.use((db) => {
      db.insert(taskBoardSql.TaskBoardTable).values([
        {
          id: "task_b" as TaskBoardID,
          team_id: teamID,
          title: "B task",
          description: "second",
          status: "pending",
          assigned_engineer_id: null,
          file_scope: null,
          blocked_by: null,
          parent_task_id: null,
          dependencies: "[]",
          review_packet: null,
          time_created: 10,
          time_updated: 10,
          completed_at: null,
          archived_at: null,
        },
        {
          id: "task_a" as TaskBoardID,
          team_id: teamID,
          title: "A task",
          description: "first",
          status: "completed",
          assigned_engineer_id: null,
          file_scope: null,
          blocked_by: null,
          parent_task_id: null,
          dependencies: "[]",
          review_packet: encodeReviewPacket(buildReviewPacket({
            status: "completed",
            summary: "Implemented and tested",
            reportPath: ".tmp/report.md",
            changedFiles: ["src/team/mission-contract.ts"],
            verificationCommands: ["bun test src/team/mission-contract.test.ts"],
            confidence: "high",
          })),
          time_created: 10,
          time_updated: 10,
          completed_at: 11,
          archived_at: null,
        },
      ]).run()
    })

    const rendered = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.render(contract.id)
      }),
    )

    expect(rendered.indexOf("# Mission overview")).toBeLessThan(rendered.indexOf("## Status and phase"))
    expect(rendered.indexOf("## Status and phase")).toBeLessThan(rendered.indexOf("## Objective"))
    expect(rendered.indexOf("## Objective")).toBeLessThan(rendered.indexOf("## Success criteria"))
    expect(rendered.indexOf("## Success criteria")).toBeLessThan(rendered.indexOf("## Constraints"))
    expect(rendered.indexOf("## Constraints")).toBeLessThan(rendered.indexOf("## Non-goals"))
    expect(rendered.indexOf("## Non-goals")).toBeLessThan(rendered.indexOf("## Human gates"))
    expect(rendered.indexOf("## Human gates")).toBeLessThan(rendered.indexOf("## Task graph summary"))
    expect(rendered.indexOf("## Task graph summary")).toBeLessThan(rendered.indexOf("## Review packet summary"))
    expect(rendered.indexOf("## Review packet summary")).toBeLessThan(rendered.indexOf("## Revision history"))
    expect(rendered.indexOf("- [completed] A task")).toBeLessThan(rendered.indexOf("- [pending] B task"))
    expect(rendered).toContain("- r1 create by session_lead")
    expect(rendered).toContain("- r2 tighten constraints by session_lead")
    expect(rendered).toContain("- r3 approve by session_lead")

    const exported = await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        const result = yield* repo.exportMarkdown(contract.id)
        return { result, stored: yield* repo.get(contract.id), rerendered: yield* repo.render(contract.id) }
      }),
    )

    expect(exported.result.exportPath).toBe(path.join(".tmp", "team", teamID, "mission.md"))
    expect(existsSync(exported.result.exportPath)).toBe(true)
    expect(exported.stored?.exportPath).toBe(exported.result.exportPath)
    expect(readFileSync(exported.result.exportPath, "utf8")).toContain(`- Export path: ${exported.result.exportPath}`)
    expect(exported.rerendered).toContain(`- Export path: ${exported.result.exportPath}`)

    await runRepo(
      Effect.gen(function* () {
        const repo = yield* mission.Service
        return yield* repo.setPhase({
          contractID: contract.id,
          phase: "implementation",
          status: "executing",
          reason: "begin implementation",
          authorSessionID: sessionLead,
        })
      }),
    )

    const refreshedExport = readFileSync(exported.result.exportPath, "utf8")
    expect(refreshedExport).toContain("- Status: executing")
    expect(refreshedExport).toContain("- Phase: implementation")
    expect(refreshedExport).toContain("- r4 begin implementation by session_lead")
  })
})
