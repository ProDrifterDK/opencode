import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"
import { Service as SessionCoordinatorService } from "@/team/session-coordinator"

export const TeamRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Get team status",
      description: "Get the current team status including all active teams and their engineers.",
      operationId: "team.status",
      responses: {
        200: {
          description: "Team status",
          content: {
            "application/json": {
              schema: resolver(z.any()),
            },
          },
        },
      },
    }),
    async (c) =>
      jsonRequest("TeamRoutes.status", c, function* () {
        const coordinator = yield* SessionCoordinatorService
        const teams = yield* coordinator.listTeams()
        const result = yield* Effect.all(
          teams.map((team) =>
            Effect.gen(function* () {
              const engineers = yield* coordinator.listTeamEngineers(team.teamID)
              return { ...team, engineers }
            }),
          ),
          { concurrency: 5 },
        )
        return result
      }),
  ),
)
