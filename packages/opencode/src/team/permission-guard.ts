import { Schema, Context, Effect, Layer } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Wildcard } from "@/util"
import { Log } from "@/util"
import { SessionID } from "@/session/schema"
import { Mailbox } from "./mailbox"
import { EngineerID } from "./types"

const log = Log.create({ service: "permission-guard" })

// ─── Scope definition ─────────────────────────────────────────────────────────

export class FileScopeEntry extends Schema.Class<FileScopeEntry>("FileScopeEntry")({
  sessionID: SessionID,
  engineerID: EngineerID,
  scopes: Schema.Array(Schema.String),
}) {
  static readonly zod = zod(this)
}

// ─── Errors ────────────────────────────────────────────────────────────────────

export class ScopeDeniedError extends Schema.TaggedErrorClass<ScopeDeniedError>()(
  "ScopeDeniedError",
  {
    path: Schema.String,
    scopes: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `File scope denied: path "${this.path}" is outside assigned scopes [${this.scopes.join(", ")}]`
  }
}

// ─── Service interface ─────────────────────────────────────────────────────────

export interface Interface {
  readonly register: (entry: FileScopeEntry) => Effect.Effect<void>
  readonly unregister: (sessionID: SessionID) => Effect.Effect<void>
  readonly check: (sessionID: SessionID, filePath: string) => Effect.Effect<void, ScopeDeniedError>
  readonly isEngineer: (sessionID: SessionID) => boolean
  // Service-level wrapper around `check` that knows which tools to gate
  // and how to pull the target path out of their args. Use this from
  // call sites that don't know about GUARDED_TOOLS / extractFilePath
  // internals (e.g. session/prompt.ts before `tool.execute.before`).
  readonly enforceForTool: (
    sessionID: SessionID,
    toolID: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<void, ScopeDeniedError>
}

// ─── State ─────────────────────────────────────────────────────────────────────

interface State {
  engineers: Map<string, FileScopeEntry>
}

// ─── Scope matching ────────────────────────────────────────────────────────────

/**
 * Check if a file path matches any of the assigned glob scopes.
 * Uses the Wildcard utility from the permission system for consistent matching.
 */
export function matchesScope(filePath: string, scopes: ReadonlyArray<string>): boolean {
  for (const scope of scopes) {
    if (Wildcard.match(filePath, scope)) return true
  }
  return false
}

// ─── Extract file paths from tool args ─────────────────────────────────────────

const GUARDED_TOOLS = new Set(["edit", "write", "bash"])

/**
 * Extract the target file path from tool arguments for scope checking.
 * Returns undefined if the tool/args don't target a file.
 */
export function extractFilePath(toolID: string, args: Record<string, unknown>): string | undefined {
  if (toolID === "edit" || toolID === "write") {
    const p = args.filePath ?? args.path
    return typeof p === "string" ? p : undefined
  }
  if (toolID === "bash") {
    return undefined
  }
  return undefined
}

// ─── Service ───────────────────────────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/FileScopeGuard") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mailbox = yield* Mailbox.Service
    const state: State = { engineers: new Map() }

    const register = Effect.fn("FileScopeGuard.register")(function* (entry: FileScopeEntry) {
      state.engineers.set(entry.sessionID, entry)
      log.info("registered engineer scopes", {
        sessionID: entry.sessionID,
        engineerID: entry.engineerID,
        scopes: entry.scopes,
      })
    })

    const unregister = Effect.fn("FileScopeGuard.unregister")(function* (sessionID: SessionID) {
      state.engineers.delete(sessionID)
      log.info("unregistered engineer", { sessionID })
    })

    const check = (sessionID: SessionID, filePath: string): Effect.Effect<void, ScopeDeniedError> =>
      Effect.gen(function* () {
        const entry = state.engineers.get(sessionID)
        if (!entry) return
        if (matchesScope(filePath, entry.scopes)) return

        yield* mailbox.send({
          recipientSessionID: entry.sessionID,
          senderSessionID: sessionID,
          priority: "urgent",
          type: "scope_violation",
          content: `Engineer ${entry.engineerID} attempted to edit out-of-scope file: ${filePath}. Assigned scopes: [${entry.scopes.join(", ")}]`,
        }).pipe(Effect.catch(() => Effect.sync(() => log.warn("failed to notify lead", { filePath }))))

        return yield* new ScopeDeniedError({ path: filePath, scopes: entry.scopes })
      })

    const isEngineer = (sessionID: SessionID): boolean => state.engineers.has(sessionID)

    const enforceForTool = (
      sessionID: SessionID,
      toolID: string,
      args: Record<string, unknown>,
    ): Effect.Effect<void, ScopeDeniedError> => {
      if (!state.engineers.has(sessionID)) return Effect.void
      if (!GUARDED_TOOLS.has(toolID)) return Effect.void
      const filePath = extractFilePath(toolID, args)
      if (!filePath) return Effect.void
      return check(sessionID, filePath)
    }

    return Service.of({ register, unregister, check, isEngineer, enforceForTool })
  }),
)

// ─── Hook integration ──────────────────────────────────────────────────────────

/**
 * Create a `tool.execute.before` hook handler that enforces file scope restrictions.
 *
 * Usage:
 * ```ts
 * plugin.trigger("tool.execute.before", { tool, sessionID, callID }, { args })
 * ```
 *
 * The guard inspects the args for edit/write/bash tools and denies if the target
 * file is outside the engineer's assigned scope.
 */
export function beforeToolExecute(
  getSessionID: () => SessionID,
  getService: () => Interface,
): (toolID: string, args: Record<string, unknown>) => Effect.Effect<void, ScopeDeniedError> {
  return (toolID, args) =>
    Effect.gen(function* () {
      const service = getService()
      const sessionID = getSessionID()

      if (!service.isEngineer(sessionID)) return
      if (!GUARDED_TOOLS.has(toolID)) return

      const filePath = extractFilePath(toolID, args)
      if (!filePath) return

      yield* service.check(sessionID, filePath)
    })
}

export const defaultLayer = layer.pipe(Layer.provide(Mailbox.layer))

export * as PermissionGuard from "./permission-guard"
