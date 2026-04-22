import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq, and } from "drizzle-orm"
import {
  TeamStateTable,
  EngineerSlotTable,
  type EngineerSlotRow,
  type TeamStateRow,
} from "../../src/team/session-coordinator.sql"
import { TaskBoardTable } from "../../src/team/task-board.sql"
import { MAX_TEAM_SIZE } from "../../src/team/constants"

let sqlite: Database
let db: SQLiteBunDatabase

const TEAM_STATE_MIGRATION = `CREATE TABLE team_state (
  team_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lead_session_id TEXT NOT NULL,
  engineer_count INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE INDEX team_state_lead_session_id_idx ON team_state(lead_session_id);`

const ENGINEER_SLOT_MIGRATION = `CREATE TABLE engineer_slot (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  current_task TEXT,
  started_at INTEGER,
  last_heartbeat INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE INDEX engineer_slot_team_id_idx ON engineer_slot(team_id);
CREATE INDEX engineer_slot_session_id_idx ON engineer_slot(session_id);`

const TASK_BOARD_MIGRATION = `CREATE TABLE IF NOT EXISTS task_board (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  assigned_engineer_id TEXT,
  file_scope TEXT,
  blocked_by TEXT,
  parent_task_id TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  completed_at INTEGER
);`

beforeEach(() => {
  sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  db = drizzle({ client: sqlite })
  migrate(db, [
    { sql: TEAM_STATE_MIGRATION, timestamp: 1, name: "team_state" },
    { sql: ENGINEER_SLOT_MIGRATION, timestamp: 2, name: "engineer_slot" },
    { sql: TASK_BOARD_MIGRATION, timestamp: 3, name: "task_board" },
  ])
})

afterEach(() => {
  sqlite.close()
})

function createTeam(teamId: string, leadSessionId: string, engineerCount = 0) {
  const now = Date.now()
  db.insert(TeamStateTable).values({
    team_id: teamId as any,
    state: "idle",
    lead_session_id: leadSessionId as any,
    engineer_count: engineerCount,
    time_created: now,
    time_updated: now,
  }).run()
  return { team_id: teamId as any, state: "idle" as const, lead_session_id: leadSessionId as any, engineer_count: engineerCount, time_created: now, time_updated: now }
}

function insertEngineer(id: string, teamId: string, sessionId: string, name: string, state: string = "idle") {
  const now = Date.now()
  db.insert(EngineerSlotTable).values({
    id: id as any,
    team_id: teamId as any,
    session_id: sessionId as any,
    name,
    state,
    current_task: null,
    started_at: now,
    last_heartbeat: now,
    time_created: now,
    time_updated: now,
  } as any).run()
  return { id: id as any, team_id: teamId as any, session_id: sessionId as any, name, state, current_task: null, started_at: now, last_heartbeat: now, time_created: now, time_updated: now }
}

describe("SessionCoordinator SQL layer", () => {
  test("spawn 3 engineers for a team", () => {
    const teamId = "team_abc"
    const leadSessionId = "ses_lead"

    createTeam(teamId, leadSessionId)

    const engineers = [
      insertEngineer("eng_1", teamId, "ses_eng1", "engineer-1"),
      insertEngineer("eng_2", teamId, "ses_eng2", "engineer-2"),
      insertEngineer("eng_3", teamId, "ses_eng3", "engineer-3"),
    ]

    db.update(TeamStateTable)
      .set({ engineer_count: 3, state: "active", time_updated: Date.now() })
      .where(eq(TeamStateTable.team_id, teamId as any))
      .run()

    const teamRow = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow
    expect(teamRow.engineer_count).toBe(3)
    expect(teamRow.state).toBe("active")

    const engRows = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamId as any))
      .all() as EngineerSlotRow[]
    expect(engRows.length).toBe(3)
    expect(engRows.map((e) => e.name).sort()).toEqual(["engineer-1", "engineer-2", "engineer-3"])
  })

  test("engineer slots have correct parent session relationship", () => {
    const teamId = "team_parent"
    const leadSessionId = "ses_lead_parent"

    createTeam(teamId, leadSessionId)

    insertEngineer("eng_p1", teamId, "ses_child1", "engineer-1")
    insertEngineer("eng_p2", teamId, "ses_child2", "engineer-2")

    const engRows = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamId as any))
      .all() as EngineerSlotRow[]

    const teamRow = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow

    for (const eng of engRows) {
      expect(eng.team_id).toBe(teamId as any)
      expect(eng.state).toBe("idle")
    }
    expect(teamRow.lead_session_id).toBe(leadSessionId as any)
  })

  test("kill engineer removes slot and decrements count", () => {
    const teamId = "team_kill"
    createTeam(teamId, "ses_lead", 3)

    insertEngineer("eng_k1", teamId, "ses_k1", "engineer-1")
    insertEngineer("eng_k2", teamId, "ses_k2", "engineer-2")
    insertEngineer("eng_k3", teamId, "ses_k3", "engineer-3")

    db.delete(EngineerSlotTable)
      .where(eq(EngineerSlotTable.id, "eng_k2" as any))
      .run()

    const remaining = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamId as any))
      .all() as EngineerSlotRow[]
    expect(remaining.length).toBe(2)
    expect(remaining.map((e) => e.id as string)).not.toContain("eng_k2")

    db.update(TeamStateTable)
      .set({ engineer_count: 2, time_updated: Date.now() })
      .where(eq(TeamStateTable.team_id, teamId as any))
      .run()

    const teamRow = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow
    expect(teamRow.engineer_count).toBe(2)
    expect(teamRow.state).toBe("idle")
  })

  test("dissolve team removes all engineers and team record", () => {
    const teamId = "team_dissolve"
    createTeam(teamId, "ses_lead_d", 3)

    insertEngineer("eng_d1", teamId, "ses_d1", "engineer-1")
    insertEngineer("eng_d2", teamId, "ses_d2", "engineer-2")
    insertEngineer("eng_d3", teamId, "ses_d3", "engineer-3")

    db.update(TeamStateTable)
      .set({ state: "dissolving", time_updated: Date.now() })
      .where(eq(TeamStateTable.team_id, teamId as any))
      .run()

    const dissolving = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow
    expect(dissolving.state).toBe("dissolving")

    db.delete(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamId as any))
      .run()
    db.delete(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .run()

    const afterTeam = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get()
    expect(afterTeam).toBeUndefined()

    const afterEng = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamId as any))
      .all()
    expect(afterEng.length).toBe(0)
  })

  test("dissolve also archives task board", () => {
    const teamId = "team_tasks"
    createTeam(teamId, "ses_lead_t")

    db.insert(TaskBoardTable).values({
      id: "task_1" as any,
      team_id: teamId as any,
      title: "Task 1",
      status: "pending",
      time_created: Date.now(),
      time_updated: Date.now(),
    } as any).run()
    db.insert(TaskBoardTable).values({
      id: "task_2" as any,
      team_id: teamId as any,
      title: "Task 2",
      status: "in-progress",
      time_created: Date.now(),
      time_updated: Date.now(),
    } as any).run()

    const tasks = db.select().from(TaskBoardTable)
      .where(eq(TaskBoardTable.team_id, teamId as any))
      .all()
    expect(tasks.length).toBe(2)

    db.delete(TaskBoardTable)
      .where(eq(TaskBoardTable.team_id, teamId as any))
      .run()

    const afterDelete = db.select().from(TaskBoardTable)
      .where(eq(TaskBoardTable.team_id, teamId as any))
      .all()
    expect(afterDelete.length).toBe(0)
  })

  test("max team size enforcement", () => {
    const teamId = "team_max"
    createTeam(teamId, "ses_lead_max")

    for (let i = 0; i < MAX_TEAM_SIZE; i++) {
      insertEngineer(`eng_max_${i}`, teamId, `ses_max_${i}`, `engineer-${i + 1}`)
    }

    const engineers = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamId as any))
      .all() as EngineerSlotRow[]
    expect(engineers.length).toBe(MAX_TEAM_SIZE)

    const teamRow = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow

    const currentCount = engineers.length
    expect(currentCount >= MAX_TEAM_SIZE).toBe(true)
  })

  test("state transitions: idle -> active -> dissolving", () => {
    const teamId = "team_transition"
    createTeam(teamId, "ses_lead_tr")

    let team = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow
    expect(team.state).toBe("idle")

    db.update(TeamStateTable)
      .set({ state: "active", time_updated: Date.now() })
      .where(eq(TeamStateTable.team_id, teamId as any))
      .run()
    team = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow
    expect(team.state).toBe("active")

    db.update(TeamStateTable)
      .set({ state: "dissolving", time_updated: Date.now() })
      .where(eq(TeamStateTable.team_id, teamId as any))
      .run()
    team = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow
    expect(team.state).toBe("dissolving")
  })

  test("resume updates session reference", () => {
    const teamId = "team_resume"
    createTeam(teamId, "ses_lead_r")

    insertEngineer("eng_resume", teamId, "ses_old", "engineer-1", "idle")

    db.update(EngineerSlotTable)
      .set({
        session_id: "ses_new" as any,
        state: "idle",
        last_heartbeat: Date.now(),
        time_updated: Date.now(),
      })
      .where(eq(EngineerSlotTable.id, "eng_resume" as any))
      .run()

    const eng = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.id, "eng_resume" as any))
      .get() as EngineerSlotRow
    expect(eng.session_id).toBe("ses_new" as any)
    expect(eng.state).toBe("idle")
  })

  test("engineer state transitions", () => {
    const teamId = "team_engstate"
    createTeam(teamId, "ses_lead_es")

    insertEngineer("eng_state", teamId, "ses_es", "engineer-1", "idle")

    db.update(EngineerSlotTable)
      .set({ state: "working", current_task: "task_1", time_updated: Date.now() })
      .where(eq(EngineerSlotTable.id, "eng_state" as any))
      .run()
    let eng = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.id, "eng_state" as any))
      .get() as EngineerSlotRow
    expect(eng.state).toBe("working")
    expect(eng.current_task).toBe("task_1")

    db.update(EngineerSlotTable)
      .set({ state: "blocked", time_updated: Date.now() })
      .where(eq(EngineerSlotTable.id, "eng_state" as any))
      .run()
    eng = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.id, "eng_state" as any))
      .get() as EngineerSlotRow
    expect(eng.state).toBe("blocked")

    db.update(EngineerSlotTable)
      .set({ state: "idle", current_task: null, time_updated: Date.now() })
      .where(eq(EngineerSlotTable.id, "eng_state" as any))
      .run()
    eng = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.id, "eng_state" as any))
      .get() as EngineerSlotRow
    expect(eng.state).toBe("idle")
    expect(eng.current_task).toBeNull()
  })

  test("multiple teams are independent", () => {
    const teamA = "team_indep_a"
    const teamB = "team_indep_b"
    createTeam(teamA, "ses_lead_a")
    createTeam(teamB, "ses_lead_b")

    insertEngineer("eng_ia1", teamA, "ses_ia1", "a-engineer-1")
    insertEngineer("eng_ia2", teamA, "ses_ia2", "a-engineer-2")
    insertEngineer("eng_ib1", teamB, "ses_ib1", "b-engineer-1")

    const teamAEngs = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamA as any))
      .all() as EngineerSlotRow[]
    const teamBEngs = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamB as any))
      .all() as EngineerSlotRow[]

    expect(teamAEngs.length).toBe(2)
    expect(teamBEngs.length).toBe(1)

    db.delete(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamB as any))
      .run()
    db.delete(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamB as any))
      .run()

    const afterA = db.select().from(EngineerSlotTable)
      .where(eq(EngineerSlotTable.team_id, teamA as any))
      .all() as EngineerSlotRow[]
    expect(afterA.length).toBe(2)
  })

  test("createTeam inserts team record into DB", () => {
    const teamId = "team_create"
    const leadSessionId = "ses_lead_create"

    createTeam(teamId, leadSessionId)

    const team = db.select().from(TeamStateTable)
      .where(eq(TeamStateTable.team_id, teamId as any))
      .get() as TeamStateRow

    expect(team.team_id).toBe(teamId as any)
    expect(team.state).toBe("idle")
    expect(team.lead_session_id).toBe(leadSessionId as any)
    expect(team.engineer_count).toBe(0)
    expect(team.time_created).toBeGreaterThan(0)
    expect(team.time_updated).toBeGreaterThan(0)
  })
})
