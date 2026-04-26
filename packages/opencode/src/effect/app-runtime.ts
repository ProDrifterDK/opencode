import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "./observability"

import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Bus } from "@/bus"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config"
import { Git } from "@/git"
import { Ripgrep } from "@/file/ripgrep"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Storage } from "@/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider"
import { ProviderAuth } from "@/provider"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool"
import { ToolRegistry } from "@/tool"
import { Format } from "@/format"
import { Project } from "@/project"
import { Vcs } from "@/project"
import { Worktree } from "@/worktree"
import { Pty } from "@/pty"
import { Installation } from "@/installation"
import { ShareNext } from "@/share"
import { SessionShare } from "@/share"
import { SessionCoordinator } from "@/team/session-coordinator"
import { LeadCoordinator } from "@/team/lead-coordinator"
import { TaskBoardRepo } from "@/team/task-board"
import { Mailbox } from "@/team/mailbox"
import { TeamDaemon } from "@/team/daemon"
import { GitManager } from "@/team/git-manager"
import { RateLimiter } from "@/team/rate-limiter"
import { HeartbeatMonitor } from "@/team/heartbeat"
import { layer as engineerProcessManagerLayer, Service as EngineerProcessManagerService } from "@/team/engineer-process-manager"
import { Npm } from "@/npm"
import { memoMap } from "./memo-map"

// Explicit service union for the application's root layer. Annotating
// AppLayer breaks the implicit-any cycle between AppLayer, the
// ManagedRuntime, and AppRuntime (TS7022/TS2456/TS2502).
type AppServices =
  | Npm.Service
  | AppFileSystem.Service
  | Bus.Service
  | Auth.Service
  | Account.Service
  | Config.Service
  | Git.Service
  | Ripgrep.Service
  | File.Service
  | FileWatcher.Service
  | Storage.Service
  | Snapshot.Service
  | Plugin.Service
  | Provider.Service
  | ProviderAuth.Service
  | Agent.Service
  | Skill.Service
  | Discovery.Service
  | Question.Service
  | Permission.Service
  | Todo.Service
  | Session.Service
  | SessionStatus.Service
  | SessionRunState.Service
  | SessionProcessor.Service
  | SessionCompaction.Service
  | SessionRevert.Service
  | SessionSummary.Service
  | SessionPrompt.Service
  | Instruction.Service
  | LLM.Service
  | LSP.Service
  | MCP.Service
  | McpAuth.Service
  | Command.Service
  | Truncate.Service
  | ToolRegistry.Service
  | Format.Service
  | Project.Service
  | Vcs.Service
  | Worktree.Service
  | Pty.Service
  | Installation.Service
  | ShareNext.Service
  | SessionShare.Service
  | TaskBoardRepo.Service
  | Mailbox.Service
  | LeadCoordinator.Service
  | SessionCoordinator.Service
  | GitManager.Service
  | RateLimiter.Service
  | EngineerProcessManagerService
  | HeartbeatMonitor.Service
  | TeamDaemon.Service

// Layers whose dependencies are entirely satisfied by other members of
// AppLayer. Composed in parallel via Layer.mergeAll.
const baseLayer = Layer.mergeAll(
  Npm.defaultLayer,
  AppFileSystem.defaultLayer,
  Bus.defaultLayer,
  Auth.defaultLayer,
  Account.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Ripgrep.defaultLayer,
  File.defaultLayer,
  FileWatcher.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Plugin.defaultLayer,
  Provider.defaultLayer,
  ProviderAuth.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  Discovery.defaultLayer,
  Question.defaultLayer,
  Permission.defaultLayer,
  Todo.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  SessionRunState.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  LSP.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Truncate.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Worktree.defaultLayer,
  Pty.defaultLayer,
  Installation.defaultLayer,
  ShareNext.defaultLayer,
  SessionShare.defaultLayer,
  GitManager.layer,
  RateLimiter.layer,
  engineerProcessManagerLayer,
  TaskBoardRepo.layer,
  Mailbox.defaultLayer,
)

// LeadCoordinator depends on TaskBoardRepo + RateLimiter (both in baseLayer).
// SessionCoordinator depends on Session + Mailbox + TaskBoardRepo + GitManager
// (all in baseLayer). Compose them after baseLayer with Layer.provideMerge so
// their dependencies resolve cleanly.
const coordinatorLayer = Layer.mergeAll(
  LeadCoordinator.layer,
  SessionCoordinator.defaultLayer,
).pipe(Layer.provideMerge(baseLayer))

// ToolRegistry.defaultLayer requires SessionCoordinator + LeadCoordinator +
// TaskBoardRepo + Mailbox to be provided externally. SessionPrompt.defaultLayer
// requires TaskBoardRepo + Mailbox + ToolRegistry as well, so they share a tier.
const toolRegistryLayer = Layer.mergeAll(
  ToolRegistry.defaultLayer,
  SessionPrompt.defaultLayer,
).pipe(Layer.provideMerge(coordinatorLayer))

// HeartbeatMonitor depends on SessionCoordinator + LeadCoordinator + Mailbox
// (all satisfied by coordinatorLayer).
const heartbeatLayer = HeartbeatMonitor.layer.pipe(Layer.provideMerge(toolRegistryLayer))

// TeamDaemon depends on Bus + SessionPrompt + SessionCoordinator + Mailbox +
// TaskBoardRepo + RateLimiter + EngineerProcessManager + HeartbeatMonitor.
const daemonLayer = TeamDaemon.layer.pipe(Layer.provideMerge(heartbeatLayer))

export const AppLayer: Layer.Layer<AppServices> = daemonLayer.pipe(
  Layer.provideMerge(Observability.layer),
)

const rt: ManagedRuntime.ManagedRuntime<AppServices, never> = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
