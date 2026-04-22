# Auto-Team Learnings

## 2026-04-22: auto-team.ts creation

- Opencode repo at `~/Documentos/projects/opencode/packages/opencode/`
- Effect service pattern: `Context.Service<Service, Interface>()("@opencode/AutoTeam")` with `Layer.effect`
- Constants `AUTO_TEAM_ENABLED`, `AUTO_TEAM_THRESHOLD`, `AUTO_TEAM_MIN_FILES` already in `./constants.ts`
- `TeamID` is a branded string from `./types.ts`
- No barrel `index.ts` in team/ — each file self-reexports with `export * as Name from "./file"`
- Pre-existing typecheck errors in `final-qa-lifecycle.test.ts` — not from our changes
- `countActionVerbs` uses `Set<string>` for distinct count per spec
- `shouldUseTeam` early-returns `false` when disabled, short-circuiting heuristic computation

## T5: Auto-team hook in prompt.ts runLoop (2026-04-22)

- `MessageV2.User` has no `.text` property — text lives in parts (`TextPart.text`). Must extract via `msgs.findLast(msg => msg.info.role === "user")` then filter parts for `type === "text"`.
- Filter synthetic parts with `!p.synthetic` when extracting user text for analysis.
- `Effect.serviceOption()` is the correct pattern for optional services — returns `Option.Some`/`Option.None`.
- `TeamID.ascending()` is in `@/team/types`, not auto-imported by default.
- `bun typecheck` pre-existing errors in `final-qa-lifecycle.test.ts` are unrelated to prompt.ts changes.
