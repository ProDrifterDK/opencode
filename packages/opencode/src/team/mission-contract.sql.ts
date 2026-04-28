import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Schema } from "effect"
import { Timestamps } from "../storage/schema.sql"
import type { SessionID } from "../session/schema"
import type { TeamID } from "./types"
import { TeamStateTable } from "./session-coordinator.sql"

export const MissionContractID = Schema.String.pipe(Schema.brand("MissionContractID"))
export type MissionContractID = Schema.Schema.Type<typeof MissionContractID>

export type MissionContractStatus =
  | "draft"
  | "ready"
  | "approved"
  | "executing"
  | "verification"
  | "delivery_ready"
  | "blocked"
  | "superseded"

export type MissionContractPhase = "ideation" | "design" | "implementation" | "verification" | "delivery"

export interface MissionContractRow {
  id: MissionContractID
  team_id: TeamID
  status: MissionContractStatus
  objective: string
  success_criteria: string
  constraints: string
  non_goals: string
  human_gates: string
  current_phase: MissionContractPhase
  approved_at: number | null
  approved_by_session_id: SessionID | null
  export_path: string | null
  time_created: number
  time_updated: number
}

export interface MissionContractRevisionRow {
  id: string
  contract_id: MissionContractID
  team_id: TeamID
  revision: number
  author_session_id: SessionID
  reason: string
  snapshot: string
  time_created: number
}

export const MissionContractTable = sqliteTable(
  "mission_contract",
  {
    id: text().$type<MissionContractID>().primaryKey(),
    team_id: text().$type<TeamID>().notNull().references(() => TeamStateTable.team_id, { onDelete: "cascade" }),
    status: text().$type<MissionContractStatus>().notNull(),
    objective: text().notNull(),
    success_criteria: text().notNull().default("[]"),
    constraints: text().notNull().default("[]"),
    non_goals: text().notNull().default("[]"),
    human_gates: text().notNull().default("[]"),
    current_phase: text().$type<MissionContractPhase>().notNull(),
    approved_at: integer(),
    approved_by_session_id: text().$type<SessionID>(),
    export_path: text(),
    ...Timestamps,
  },
  (table) => [
    index("mission_contract_team_id_idx").on(table.team_id),
    index("mission_contract_status_idx").on(table.status),
  ],
)

export const MissionContractRevisionTable = sqliteTable(
  "mission_contract_revision",
  {
    id: text().primaryKey(),
    contract_id: text().$type<MissionContractID>().notNull().references(() => MissionContractTable.id, { onDelete: "cascade" }),
    team_id: text().$type<TeamID>().notNull().references(() => TeamStateTable.team_id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    author_session_id: text().$type<SessionID>().notNull(),
    reason: text().notNull(),
    snapshot: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("mission_contract_revision_contract_id_idx").on(table.contract_id),
    index("mission_contract_revision_team_id_idx").on(table.team_id),
    uniqueIndex("mission_contract_revision_contract_id_revision_idx").on(table.contract_id, table.revision),
  ],
)
