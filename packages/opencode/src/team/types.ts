import { Schema } from "effect"

import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const TeamID = Schema.String.pipe(
  Schema.brand("TeamID"),
  withStatics((s) => ({
    ascending: (id?: string) => {
      if (id) return id as TeamID
      return ("team_" + Date.now().toString(36) + Math.random().toString(36).slice(2)) as TeamID
    },
    descending: (id?: string) => {
      if (id) return id as TeamID
      return ("team_" + (~Date.now()).toString(36) + Math.random().toString(36).slice(2)) as TeamID
    },
    zod: zod(s),
  })),
)

export type TeamID = Schema.Schema.Type<typeof TeamID>

export const EngineerID = Schema.String.pipe(
  Schema.brand("EngineerID"),
  withStatics((s) => ({
    ascending: (id?: string) => {
      if (id) return id as EngineerID
      return ("eng_" + Date.now().toString(36) + Math.random().toString(36).slice(2)) as EngineerID
    },
    descending: (id?: string) => {
      if (id) return id as EngineerID
      return ("eng_" + (~Date.now()).toString(36) + Math.random().toString(36).slice(2)) as EngineerID
    },
    zod: zod(s),
  })),
)

export type EngineerID = Schema.Schema.Type<typeof EngineerID>

export const TeamState = Schema.Literals(["idle", "active", "dissolving"]).annotate({
  identifier: "TeamState",
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type TeamState = Schema.Schema.Type<typeof TeamState>

export const EngineerState = Schema.Literals(["idle", "working", "blocked", "failed"]).annotate({
  identifier: "EngineerState",
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type EngineerState = Schema.Schema.Type<typeof EngineerState>

export const MailboxPriority = Schema.Literals(["low", "normal", "high", "urgent"]).annotate({
  identifier: "MailboxPriority",
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type MailboxPriority = Schema.Schema.Type<typeof MailboxPriority>

export class MailboxMessage extends Schema.Class<MailboxMessage>("MailboxMessage")({
  id: Schema.String,
  priority: MailboxPriority,
  sender: EngineerID,
  recipient: EngineerID,
  content: Schema.String,
  timestamp: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class TaskAssignment extends Schema.Class<TaskAssignment>("TaskAssignment")({
  taskID: Schema.String,
  assignee: EngineerID,
  fileScope: Schema.Array(Schema.String),
  assignedAt: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class TeamConfig extends Schema.Class<TeamConfig>("TeamConfig")({
  teamID: TeamID,
  name: Schema.String,
  maxSize: Schema.Number,
  maxConcurrentLLMCalls: Schema.Number,
  heartbeatIntervalMs: Schema.Number,
  engineerMaxIdleMs: Schema.Number,
  engineerMaxRuntimeMs: Schema.Number,
  mailboxQueueDepth: Schema.Number,
  leadContextBudget: Schema.Number,
  taskBoardMaxTasks: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class EngineerStateRecord extends Schema.Class<EngineerStateRecord>("EngineerStateRecord")({
  engineerID: EngineerID,
  name: Schema.String,
  state: EngineerState,
  currentTask: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  lastHeartbeat: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class TeamStateRecord extends Schema.Class<TeamStateRecord>("TeamStateRecord")({
  teamID: TeamID,
  state: TeamState,
  leadSessionID: Schema.String,
  engineerCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {
  static readonly zod = zod(this)
}
