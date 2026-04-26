import { eq } from "drizzle-orm"
import { Effect, Layer, Context, Schema, Cause } from "effect"
import { Database } from "@/storage"
import { Log } from "@/util"

const log = Log.create({ service: "team.session-coordinator" })
import { Service as SessionService, defaultLayer as sessionDefaultLayer } from "@/session/session"
import { Service as MailboxService, defaultLayer as mailboxDefaultLayer } from "./mailbox"
import { Service as TaskBoardService, layer as taskBoardLayer } from "./task-board"
import { Service as GitManagerService, layer as gitManagerLayer } from "./git-manager"
import { TeamStateTable, EngineerSlotTable, type EngineerSlotRow, type TeamStateRow } from "./session-coordinator.sql"
import { TeamID, EngineerID, type EngineerState } from "./types"
import { MAX_TEAM_SIZE } from "./constants"
import { Event, publishTeamEvent } from "./events"
import type { SessionID } from "../session/schema"
import { deriveEngineerName } from "./engineer-naming"

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
  agentName: string | null
  agentColor: string | null
  fallbackAgent: string | null
  startedAt: number | null
  lastHeartbeat: number
}

export interface TeamRecord {
  teamID: TeamID
  state: "idle" | "active" | "dissolving" | "terminated"
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
    taskTitle?: string
    agentName?: string
    agentColor?: string
    fallbackAgent?: string
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
  readonly resumeTeam: (teamID: TeamID) => Effect.Effect<{ team: TeamRecord; engineers: EngineerSlot[] }, CoordinatorError>
  readonly getTeam: (teamID: TeamID) => Effect.Effect<TeamRecord | null, CoordinatorError>
  readonly getEngineer: (engineerID: EngineerID) => Effect.Effect<EngineerSlot | null, CoordinatorError>
  readonly listTeamEngineers: (
    teamID: TeamID,
    options?: { liveOnly?: boolean },
  ) => Effect.Effect<EngineerSlot[], CoordinatorError>
  readonly listAllEngineers: () => Effect.Effect<EngineerSlot[], CoordinatorError>
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

// Translate SQL rows to the coordinator's domain types. These used to
// live inline in `hydrateFromDb`, and the engineer translator silently
// dropped `agent_name` / `agent_color` — after a process restart, every
// slot lost its agent metadata. Centralising the mapping here means the
// bug can't recur per-method.
const rowToSlot = (row: EngineerSlotRow): EngineerSlot => ({
  engineerID: row.id,
  teamID: row.team_id,
  sessionID: row.session_id,
  name: row.name,
  state: row.state as EngineerState,
  currentTask: row.current_task,
  agentName: row.agent_name,
  agentColor: row.agent_color,
  fallbackAgent: row.fallback_agent_name,
  startedAt: row.started_at,
  lastHeartbeat: row.last_heartbeat,
})

const rowToTeam = (row: TeamStateRow): TeamRecord => ({
  teamID: row.team_id,
  state: row.state,
  leadSessionID: row.lead_session_id,
  engineerCount: row.engineer_count,
  createdAt: row.time_created,
  updatedAt: row.time_updated,
})

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCoordinator") {}

// All reads and writes go through the SQLite database — no in-memory
// mirror. The previous implementation kept two `Map`s hydrated once at
// layer init; any write that bypassed the service (for example the
// synchronous SIGINT path in daemon.ts) would leave the maps lying
// about reality until restart. The DB is now the single source of
// truth, so that class of drift is impossible.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* SessionService
    const mailbox = yield* MailboxService
    const taskBoard = yield* TaskBoardService
    const gitManager = yield* GitManagerService

    const fetchTeam = (teamID: TeamID) =>
      dbQuery((db) =>
        db.select().from(TeamStateTable).where(eq(TeamStateTable.team_id, teamID)).all(),
      ).pipe(Effect.map((rows) => (rows.length > 0 ? rowToTeam(rows[0]) : null)))

    const fetchEngineer = (engineerID: EngineerID) =>
      dbQuery((db) =>
        db.select().from(EngineerSlotTable).where(eq(EngineerSlotTable.id, engineerID)).all(),
      ).pipe(Effect.map((rows) => (rows.length > 0 ? rowToSlot(rows[0]) : null)))

    const countTeamEngineers = (teamID: TeamID) =>
      dbQuery((db) =>
        db.select().from(EngineerSlotTable).where(eq(EngineerSlotTable.team_id, teamID)).all(),
      ).pipe(Effect.map((rows) => rows.length))

    const createTeam = Effect.fn("SessionCoordinator.createTeam")(function* (input: {
      teamID: TeamID
      leadSessionID: SessionID
      goal?: string
    }) {
      const existing = yield* fetchTeam(input.teamID)
      if (existing) {
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
          team_id: record.teamID,
          state: record.state,
          lead_session_id: record.leadSessionID,
          engineer_count: record.engineerCount,
          time_created: now,
          time_updated: now,
        }).run()
      })

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
      taskTitle?: string
      agentName?: string
      agentColor?: string
      fallbackAgent?: string
    }) {
      const team = yield* fetchTeam(input.teamID)
      if (!team) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team not found: ${input.teamID}` }))
      }

      const currentCount = yield* countTeamEngineers(input.teamID)
      if (currentCount >= MAX_TEAM_SIZE) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team ${input.teamID} has reached max size (${MAX_TEAM_SIZE})` }))
      }

      const sessionInfo = yield* session.create({
        parentID: input.leadSessionID,
        title: `Engineer session (@engineer subagent)`,
      })

      const engineerID = EngineerID.ascending() as EngineerID
      const now = Date.now()
      const engName = input.name ?? deriveEngineerName(input.taskTitle, currentCount + 1)

      const slot: EngineerSlot = {
        engineerID,
        teamID: input.teamID,
        sessionID: sessionInfo.id,
        name: engName,
        state: "idle",
        currentTask: null,
        agentName: input.agentName ?? null,
        agentColor: input.agentColor ?? null,
        fallbackAgent: input.fallbackAgent ?? null,
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
          agent_name: slot.agentName,
          agent_color: slot.agentColor,
          fallback_agent_name: slot.fallbackAgent,
          started_at: slot.startedAt,
          last_heartbeat: slot.lastHeartbeat,
          time_created: now,
          time_updated: now,
        }).run()

        db.update(TeamStateTable)
          .set({
            engineer_count: currentCount + 1,
            state: "active",
            time_updated: now,
          })
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })

      // Note: EngineerSpawned event is published by team_spawn tool
      // which has full task details (title, description)

      return slot
    })

    const resumeEngineer = Effect.fn("SessionCoordinator.resumeEngineer")(function* (input: {
      engineerID: EngineerID
      taskID: string
    }) {
      const slot = yield* fetchEngineer(input.engineerID)
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

      return updated
    })

    const killEngineer = Effect.fn("SessionCoordinator.killEngineer")(function* (input: {
      engineerID: EngineerID
      teamID: TeamID
    }) {
      const slot = yield* fetchEngineer(input.engineerID)
      if (!slot) {
        return yield* Effect.fail(new CoordinatorError({ message: `Engineer not found: ${input.engineerID}` }))
      }

      log.warn("killEngineer invoked — removing engineer session", {
        engineerID: input.engineerID,
        teamID: input.teamID,
        sessionID: slot.sessionID,
        stack: new Error().stack?.split("\n").slice(1, 6).join(" | "),
      })

      yield* session.remove(slot.sessionID).pipe(
        Effect.catchCause((cause) => {
          console.error("[Coordinator] Failed to remove session:", Cause.pretty(cause))
          return Effect.void
        }),
      )

      yield* mailbox.purge(slot.sessionID).pipe(
        Effect.catchCause((cause) => {
          console.error("[Coordinator] Failed to purge mailbox:", Cause.pretty(cause))
          return Effect.void
        }),
      )

      const now = Date.now()
      yield* dbTx((db) => {
        db.delete(EngineerSlotTable)
          .where(eq(EngineerSlotTable.id, input.engineerID))
          .run()

        // Recompute the remaining count straight from SQL so the team
        // row stays consistent even if another concurrent write raced
        // with us.
        const remaining = db
          .select()
          .from(EngineerSlotTable)
          .where(eq(EngineerSlotTable.team_id, input.teamID))
          .all()
        db.update(TeamStateTable)
          .set({
            engineer_count: remaining.length,
            state: remaining.length === 0 ? "idle" : "active",
            time_updated: now,
          })
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })

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
      const team = yield* fetchTeam(input.teamID)
      if (!team) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team not found: ${input.teamID}` }))
      }

      log.warn("dissolveTeam invoked — removing all engineer sessions", {
        teamID: input.teamID,
        stack: new Error().stack?.split("\n").slice(1, 6).join(" | "),
      })

      yield* dbTx((db) => {
        db.update(TeamStateTable)
          .set({ state: "dissolving", time_updated: Date.now() })
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })

      const engineerRows = yield* dbQuery((db) =>
        db.select().from(EngineerSlotTable).where(eq(EngineerSlotTable.team_id, input.teamID)).all(),
      )

      yield* Effect.forEach(engineerRows, (row) =>
        Effect.all([
          session.remove(row.session_id).pipe(
            Effect.catchCause((cause) => {
              console.error("[Coordinator] Failed to remove session:", Cause.pretty(cause))
              return Effect.void
            }),
          ),
          mailbox.purge(row.session_id).pipe(
            Effect.catchCause((cause) => {
              console.error("[Coordinator] Failed to purge mailbox:", Cause.pretty(cause))
              return Effect.void
            }),
          ),
        ]),
      )

      yield* taskBoard.archiveTeamBoard(input.teamID).pipe(
        Effect.catchCause((cause) => {
          console.error("[Coordinator] Failed to archive task board:", Cause.pretty(cause))
          return Effect.void
        }),
      )

      yield* gitManager.cleanupBranches(input.teamID).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to cleanup engineer worktrees on dissolve", { teamID: input.teamID, cause: Cause.pretty(cause) }),
        ),
      )

      yield* dbTx((db) => {
        db.delete(EngineerSlotTable)
          .where(eq(EngineerSlotTable.team_id, input.teamID))
          .run()
        db.delete(TeamStateTable)
          .where(eq(TeamStateTable.team_id, input.teamID))
          .run()
      })

      void publishTeamEvent(Event.TeamDissolved, {
        teamID: input.teamID,
        reason: "dissolved by lead",
      })
    })

    const resumeTeam = Effect.fn("SessionCoordinator.resumeTeam")(function* (teamID: TeamID) {
      const team = yield* fetchTeam(teamID)
      if (!team) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team not found: ${teamID}` }))
      }
      if (team.state !== "terminated") {
        return yield* Effect.fail(
          new CoordinatorError({
            message: `Cannot resume team in state ${team.state}. Only terminated teams can be resumed.`,
          }),
        )
      }

      const now = Date.now()

      // Re-activate the team and load remaining engineer slots. Slots
      // for crashed working engineers were marked `failed` by
      // gracefulShutdown; we leave that semantic intact and let the
      // caller decide whether to re-spawn them based on engineer state.
      yield* dbTx((db) => {
        db.update(TeamStateTable)
          .set({ state: "active", time_updated: now })
          .where(eq(TeamStateTable.team_id, teamID))
          .run()
      })

      const engineerRows = yield* dbQuery((db) =>
        db.select().from(EngineerSlotTable).where(eq(EngineerSlotTable.team_id, teamID)).all(),
      )

      const refreshed = yield* fetchTeam(teamID)
      if (!refreshed) {
        return yield* Effect.fail(new CoordinatorError({ message: `Team disappeared during resume: ${teamID}` }))
      }

      return { team: refreshed, engineers: engineerRows.map(rowToSlot) }
    })

    const getTeam = Effect.fn("SessionCoordinator.getTeam")((teamID: TeamID) => fetchTeam(teamID))

    const getEngineer = Effect.fn("SessionCoordinator.getEngineer")((engineerID: EngineerID) =>
      fetchEngineer(engineerID),
    )

    const listTeamEngineers = Effect.fn("SessionCoordinator.listTeamEngineers")(
      (teamID: TeamID, options?: { liveOnly?: boolean }) =>
        dbQuery((db) =>
          db.select().from(EngineerSlotTable).where(eq(EngineerSlotTable.team_id, teamID)).all(),
        ).pipe(
          Effect.map((rows) => {
            const slots = rows.map(rowToSlot)
            if (options?.liveOnly) {
              // Live = engineer slot has not failed. Excluding only
              // "failed" covers all the cases where the subprocess is
              // still around to pick up reassigned work:
              //   - "idle"    just-spawned (haven't picked task yet) OR
              //               just-completed via team_report
              //   - "working" actively running a task
              //   - "blocked" waiting on a dependency
              // The heartbeat-driven "all-engineers-failed" check uses
              // this filter; treating idle as alive prevents spurious
              // urgents when a single engineer dies while siblings are
              // still in their post-spawn idle window.
              return slots.filter((s) => s.state !== "failed")
            }
            return slots
          }),
        ),
    )

    const listAllEngineers = Effect.fn("SessionCoordinator.listAllEngineers")(() =>
      dbQuery((db) => db.select().from(EngineerSlotTable).all()).pipe(
        Effect.map((rows) => rows.map(rowToSlot)),
      ),
    )

    const listTeams = Effect.fn("SessionCoordinator.listTeams")(() =>
      dbQuery((db) => db.select().from(TeamStateTable).all()).pipe(
        Effect.map((rows) => rows.map(rowToTeam)),
      ),
    )

    const isLead = Effect.fn("SessionCoordinator.isLead")((sessionID: SessionID) =>
      dbQuery((db) =>
        db
          .select()
          .from(TeamStateTable)
          .where(eq(TeamStateTable.lead_session_id, sessionID))
          .limit(1)
          .all(),
      ).pipe(Effect.map((rows) => rows.length > 0)),
    )

    const isEngineer = Effect.fn("SessionCoordinator.isEngineer")((sessionID: SessionID) =>
      dbQuery((db) =>
        db
          .select()
          .from(EngineerSlotTable)
          .where(eq(EngineerSlotTable.session_id, sessionID))
          .limit(1)
          .all(),
      ).pipe(Effect.map((rows) => rows.length > 0)),
    )

    const getEngineerBySession = Effect.fn("SessionCoordinator.getEngineerBySession")((sessionID: SessionID) =>
      dbQuery((db) =>
        db
          .select()
          .from(EngineerSlotTable)
          .where(eq(EngineerSlotTable.session_id, sessionID))
          .limit(1)
          .all(),
      ).pipe(Effect.map((rows) => (rows.length > 0 ? rowToSlot(rows[0]) : null))),
    )

    const getTeamForSession = Effect.fn("SessionCoordinator.getTeamForSession")((sessionID: SessionID) =>
      Effect.gen(function* () {
        const asLead = yield* dbQuery((db) =>
          db
            .select()
            .from(TeamStateTable)
            .where(eq(TeamStateTable.lead_session_id, sessionID))
            .limit(1)
            .all(),
        )
        if (asLead.length > 0) return asLead[0].team_id

        const asEngineer = yield* dbQuery((db) =>
          db
            .select()
            .from(EngineerSlotTable)
            .where(eq(EngineerSlotTable.session_id, sessionID))
            .limit(1)
            .all(),
        )
        if (asEngineer.length > 0) return asEngineer[0].team_id

        return null
      }),
    )

    const updateEngineer = Effect.fn("SessionCoordinator.updateEngineer")(function* (
      engineerID: EngineerID,
      updates: { state?: EngineerState; currentTask?: string | null; lastHeartbeat?: number },
    ) {
      const slot = yield* fetchEngineer(engineerID)
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

      return updated
    })

    return Service.of({
      createTeam,
      spawnEngineer,
      resumeEngineer,
      killEngineer,
      dissolveTeam,
      resumeTeam,
      getTeam,
      getEngineer,
      listTeamEngineers,
      listAllEngineers,
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
  Layer.provide(gitManagerLayer),
)

export * as SessionCoordinator from "./session-coordinator"
