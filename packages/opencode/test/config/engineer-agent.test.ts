import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config, ConfigManaged } from "../../src/config"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Env } from "../../src/env"
import { tmpdir } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"
import fs from "fs/promises"
import { ConfigPlugin } from "@/config/plugin"
import { Npm } from "@opencode-ai/core/npm"
import { Agent } from "../../src/agent/agent"

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const testFlock = EffectFlock.defaultLayer

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const layer = Config.layer.pipe(
  Layer.provide(testFlock),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
  Layer.provide(Npm.defaultLayer),
)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))

describe("engineer agent", () => {
  test("engineer agent is registered and retrievable", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const agentsDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentsDir, { recursive: true })
        await fs.writeFile(
          path.join(agentsDir, "engineer.md"),
          `---
mode: subagent
description: Engineer agent
---
Engineer agent prompt`,
          "utf8",
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await load()
        expect(config.agent?.["engineer"]).toMatchObject({
          name: "engineer",
          mode: "subagent",
        })
      },
    })
  })

  test("engineer agent retrievable from agent service with task denied", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const agentsDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentsDir, { recursive: true })
        await fs.writeFile(
          path.join(agentsDir, "engineer.md"),
          `---
mode: subagent
description: Engineer agent
---
Engineer agent prompt`,
          "utf8",
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.gen(function* () {
          const config = yield* Effect.promise(() => load())
          expect(config.agent?.["engineer"]).toMatchObject({
            name: "engineer",
            mode: "subagent",
          })

          const agentSvc = yield* Agent.Service
          const engineer = yield* agentSvc.get("engineer")

          expect(engineer.mode).toBe("subagent")

          const taskRule = engineer.permission.find((r: { permission: string }) => r.permission === "task")
          expect(taskRule?.action).toBe("deny")
        }),
    })
  })
})
