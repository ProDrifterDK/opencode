import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { SessionID } from "../session/schema"
import type { TeamID, EngineerID } from "./types"

// =============================================================================
// Types
// =============================================================================

export type EngineerRuntimeState = "idle" | "working" | "blocked" | "failed"

export interface EngineerSlotRow {
  id: EngineerID
  team_id: TeamID
  session_id: SessionID
  name: string
  state: EngineerRuntimeState
  current_task: string | null
  started_at: number | null
  last_heartbeat: number
  time_created: number
  time_updated: number
}

export interface TeamStateRow {
  team_id: TeamID
  state: "idle" | "active" | "dissolving"
  lead_session_id: SessionID
  engineer_count: number
  time_created: number
  time_updated: number
}

// =============================================================================
// Tables
// =============================================================================

export const TeamStateTable = sqliteTable(
  "team_state",
  {
    team_id: text().$type<TeamID>().primaryKey(),
    state: text().$type<"idle" | "active" | "dissolving">().notNull(),
    lead_session_id: text().$type<SessionID>().notNull(),
    engineer_count: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("team_state_lead_session_id_idx").on(table.lead_session_id)],
)

export const EngineerSlotTable = sqliteTable(
  "engineer_slot",
  {
    id: text().$type<EngineerID>().primaryKey(),
    team_id: text().$type<TeamID>().notNull(),
    session_id: text().$type<SessionID>().notNull(),
    name: text().notNull(),
    state: text().$type<EngineerRuntimeState>().notNull(),
    current_task: text(),
    started_at: integer(),
    last_heartbeat: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("engineer_slot_team_id_idx").on(table.team_id),
    index("engineer_slot_session_id_idx").on(table.session_id),
  ],
)
