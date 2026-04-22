import { describe, expect, test } from "bun:test"
import { Effect, Layer, Exit } from "effect"
import { SessionID } from "../session/schema"
import { EngineerID } from "./types"
import {
  FileScopeEntry,
  ScopeDeniedError,
  Service,
  layer as guardLayer_,
  matchesScope,
  extractFilePath,
  beforeToolExecute,
} from "./permission-guard"
import { Mailbox, type Interface as MailboxInterface } from "./mailbox"

// ─── Pure function tests ───────────────────────────────────────────────────────

describe("matchesScope", () => {
  test("matches exact path", () => {
    expect(matchesScope("src/auth/login.ts", ["src/auth/login.ts"])).toBe(true)
  })

  test("matches glob pattern with ** (recursive)", () => {
    expect(matchesScope("src/auth/login.ts", ["src/auth/**"])).toBe(true)
    expect(matchesScope("src/auth/utils/hash.ts", ["src/auth/**"])).toBe(true)
    expect(matchesScope("src/auth/sub/deep/file.ts", ["src/auth/**"])).toBe(true)
  })

  test("matches glob pattern with ** and extension filter", () => {
    expect(matchesScope("src/auth/login.ts", ["src/auth/**.ts"])).toBe(true)
    expect(matchesScope("src/auth/utils/hash.ts", ["src/auth/**.ts"])).toBe(true)
  })

  test("matches glob pattern with *", () => {
    expect(matchesScope("src/auth/login.ts", ["src/auth/*"])).toBe(true)
    expect(matchesScope("src/auth", ["src/*"])).toBe(true)
  })

  test("rejects path outside all scopes", () => {
    expect(matchesScope("src/billing/invoice.ts", ["src/auth/**"])).toBe(false)
    expect(matchesScope("etc/passwd", ["src/**"])).toBe(false)
  })

  test("matches when multiple scopes provided", () => {
    expect(
      matchesScope("src/auth/login.ts", ["src/billing/**", "src/auth/**"]),
    ).toBe(true)
  })

  test("no scopes means no match", () => {
    expect(matchesScope("src/auth/login.ts", [])).toBe(false)
  })
})

describe("extractFilePath", () => {
  test("extracts filePath from edit tool args", () => {
    expect(extractFilePath("edit", { filePath: "/src/auth/login.ts" })).toBe(
      "/src/auth/login.ts",
    )
  })

  test("extracts path from write tool args", () => {
    expect(extractFilePath("write", { path: "/src/new-file.ts" })).toBe("/src/new-file.ts")
  })

  test("extracts filePath from write tool args (filePath variant)", () => {
    expect(extractFilePath("write", { filePath: "/src/new-file.ts" })).toBe(
      "/src/new-file.ts",
    )
  })

  test("returns undefined for bash tool", () => {
    expect(extractFilePath("bash", { command: "rm -rf /" })).toBeUndefined()
  })

  test("returns undefined for read tool", () => {
    expect(extractFilePath("read", { filePath: "/src/auth/login.ts" })).toBeUndefined()
  })

  test("returns undefined when no path in args", () => {
    expect(extractFilePath("edit", {})).toBeUndefined()
  })
})

// ─── Service tests with Effect runtime ─────────────────────────────────────────

// Minimal mock mailbox for testing — records sent messages
const createMockMailbox = () => {
  const sent: Array<{
    recipientSessionID: string
    senderSessionID: string
    priority: string
    type: string
    content: string
  }> = []

  const mockLayer = Layer.succeed(
    Mailbox.Service,
    ({
      send: (input: any) =>
        Effect.sync(() => {
          sent.push(input)
          return {
            id: "msg_" + Math.random().toString(36).slice(2),
            recipient_session_id: input.recipientSessionID,
            sender_session_id: input.senderSessionID,
            priority: input.priority,
            type: input.type,
            content: input.content,
            created_at: Date.now(),
            read_at: null,
          }
        }),
      receive: () => Effect.succeed([]),
      peek: () => Effect.succeed([]),
      markRead: () => Effect.succeed(undefined),
      purge: () => Effect.succeed(undefined),
    }) as unknown as MailboxInterface,
  )

  const guardLayer = guardLayer_.pipe(Layer.provide(mockLayer))

  return { sent, mockLayer, guardLayer }
}

describe("FileScopeGuard Service", () => {
  const ENGINEER_SESSION = "ses_engineer_001" as SessionID
  const ENGINEER_ID = "eng_auth_001" as EngineerID

  test("edit inside scope → allowed", async () => {
    const { guardLayer } = createMockMailbox()
    const program = Effect.gen(function* () {
      const guard = yield* Service
      yield* guard.register(
        new FileScopeEntry({
          sessionID: ENGINEER_SESSION,
          engineerID: ENGINEER_ID,
          scopes: ["src/auth/**"],
        }),
      )
      yield* guard.check(ENGINEER_SESSION, "src/auth/login.ts")
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(guardLayer)))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("edit outside scope → denied + lead notified", async () => {
    const { sent, guardLayer } = createMockMailbox()

    const program = Effect.gen(function* () {
      const guard = yield* Service
      yield* guard.register(
        new FileScopeEntry({
          sessionID: ENGINEER_SESSION,
          engineerID: ENGINEER_ID,
          scopes: ["src/auth/**"],
        }),
      )
      yield* guard.check(ENGINEER_SESSION, "src/billing/invoice.ts")
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(guardLayer)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as any).reasons?.[0]?.error
      expect(err._tag).toBe("ScopeDeniedError")
      expect(err.path).toBe("src/billing/invoice.ts")
      expect(err.scopes).toEqual(["src/auth/**"])
    }

    expect(sent.length).toBe(1)
    expect(sent[0].type).toBe("scope_violation")
    expect(sent[0].content).toContain("src/billing/invoice.ts")
    expect(sent[0].priority).toBe("urgent")
  })

  test("non-engineer session → allowed (no restrictions)", async () => {
    const { guardLayer } = createMockMailbox()
    const NON_ENGINEER = "ses_primary_001" as SessionID

    const program = Effect.gen(function* () {
      const guard = yield* Service
      yield* guard.check(NON_ENGINEER, "any/path/anywhere.ts")
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(guardLayer)))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("isEngineer returns true for registered session", async () => {
    const { guardLayer } = createMockMailbox()

    const program = Effect.gen(function* () {
      const guard = yield* Service
      expect(guard.isEngineer(ENGINEER_SESSION)).toBe(false)
      yield* guard.register(
        new FileScopeEntry({
          sessionID: ENGINEER_SESSION,
          engineerID: ENGINEER_ID,
          scopes: ["src/**/*.ts"],
        }),
      )
      expect(guard.isEngineer(ENGINEER_SESSION)).toBe(true)
      yield* guard.unregister(ENGINEER_SESSION)
      expect(guard.isEngineer(ENGINEER_SESSION)).toBe(false)
    })

    await Effect.runPromise(program.pipe(Effect.provide(guardLayer)))
  })

  test("unregister removes scope restrictions", async () => {
    const { guardLayer } = createMockMailbox()

    const program = Effect.gen(function* () {
      const guard = yield* Service
      yield* guard.register(
        new FileScopeEntry({
          sessionID: ENGINEER_SESSION,
          engineerID: ENGINEER_ID,
          scopes: ["src/auth/**"],
        }),
      )
      yield* guard.unregister(ENGINEER_SESSION)
      yield* guard.check(ENGINEER_SESSION, "src/billing/invoice.ts")
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(guardLayer)))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("beforeToolExecute hook", () => {
  test("denies edit tool outside scope", async () => {
    const { guardLayer } = createMockMailbox()
    const ENGINEER_SESSION = "ses_eng_hook" as SessionID

    const program = Effect.gen(function* () {
      const guard = yield* Service
      yield* guard.register(
        new FileScopeEntry({
          sessionID: ENGINEER_SESSION,
          engineerID: "eng_hook" as EngineerID,
          scopes: ["src/auth/**"],
        }),
      )

      const hook = beforeToolExecute(
        () => ENGINEER_SESSION,
        () => guard,
      )

      return yield* Effect.exit(hook("edit", { filePath: "src/billing/invoice.ts" }))
    })

    const exit = await Effect.runPromise(program.pipe(Effect.provide(guardLayer)))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("allows edit tool inside scope", async () => {
    const { guardLayer } = createMockMailbox()
    const ENGINEER_SESSION = "ses_eng_hook2" as SessionID

    const program = Effect.gen(function* () {
      const guard = yield* Service
      yield* guard.register(
        new FileScopeEntry({
          sessionID: ENGINEER_SESSION,
          engineerID: "eng_hook2" as EngineerID,
          scopes: ["src/auth/**"],
        }),
      )

      const hook = beforeToolExecute(
        () => ENGINEER_SESSION,
        () => guard,
      )

      return yield* Effect.exit(hook("edit", { filePath: "src/auth/login.ts" }))
    })

    const exit = await Effect.runPromise(program.pipe(Effect.provide(guardLayer)))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("skips non-guarded tools", async () => {
    const { guardLayer } = createMockMailbox()
    const ENGINEER_SESSION = "ses_eng_hook3" as SessionID

    const program = Effect.gen(function* () {
      const guard = yield* Service
      yield* guard.register(
        new FileScopeEntry({
          sessionID: ENGINEER_SESSION,
          engineerID: "eng_hook3" as EngineerID,
          scopes: ["src/auth/**"],
        }),
      )

      const hook = beforeToolExecute(
        () => ENGINEER_SESSION,
        () => guard,
      )

      return yield* Effect.exit(hook("read", { filePath: "src/billing/invoice.ts" }))
    })

    const exit = await Effect.runPromise(program.pipe(Effect.provide(guardLayer)))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("skips non-engineer sessions", async () => {
    const { guardLayer } = createMockMailbox()
    const PRIMARY_SESSION = "ses_primary" as SessionID

    const program = Effect.gen(function* () {
      const guard = yield* Service

      const hook = beforeToolExecute(
        () => PRIMARY_SESSION,
        () => guard,
      )

      return yield* Effect.exit(
        hook("edit", { filePath: "src/billing/invoice.ts" }),
      )
    })

    const exit = await Effect.runPromise(program.pipe(Effect.provide(guardLayer)))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
