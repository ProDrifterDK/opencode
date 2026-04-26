import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Match, Show, Switch, createSignal, onMount, onCleanup, createEffect } from "solid-js"
import { progressDisplayController, MIN_DWELL_MS } from "./progress-display"

const id = "internal:sidebar-team"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const ENGINEER_COLORS = [
  "#ff6b6b", // coral red
  "#4ecdc4", // teal
  "#ffe66d", // yellow
  "#95e1d3", // mint
  "#f38181", // salmon
  "#aa96da", // lavender
  "#fcbad3", // pink
  "#a8d8ea", // sky blue
  "#ffd93d", // gold
  "#6bcb77", // green
  "#c9b1ff", // purple
  "#ff9f45", // orange
]

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

function getEngineerColor(name: string, agentName?: string): string {
  const key = agentName || name
  const index = hashString(key) % ENGINEER_COLORS.length
  return ENGINEER_COLORS[index]
}

// Activity window: spinner shows when progressText changed within this many ms
const ACTIVITY_WINDOW_MS = 5000

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const [spinnerIdx, setSpinnerIdx] = createSignal(0)
  // Tick signal for recency-based spinner re-evaluation (flips every 1 s)
  const [tick, setTick] = createSignal(0)
  const theme = () => props.api.theme.current
  const team = createMemo(() => props.api.state.team())
  const active = createMemo(() => team().record !== null)
  const failed = createMemo(() => team().engineers.filter((e) => e.state === "failed").length)

  // Per-engineer dwell-display state: engineerID → { displayText, updatedAt }
  // Stored as plain reactive signals keyed by engineerID so Solid tracks them.
  const [displayMap, setDisplayMap] = createSignal<
    Map<string, { displayText: string | undefined; updatedAt: number }>
  >(new Map())

  // Map of engineerID → controller (not reactive — imperative cleanup handles lifecycle)
  const controllers = new Map<string, ReturnType<typeof progressDisplayController>>()

  function ensureController(engineerID: string, initialText: string | undefined) {
    if (controllers.has(engineerID)) return controllers.get(engineerID)!
    const ctrl = progressDisplayController(initialText, (text, updatedAt) => {
      setDisplayMap((prev) => {
        const next = new Map(prev)
        next.set(engineerID, { displayText: text, updatedAt })
        return next
      })
    })
    controllers.set(engineerID, ctrl)
    // Seed the map so getCurrent() is readable before any push
    setDisplayMap((prev) => {
      const next = new Map(prev)
      if (!next.has(engineerID)) {
        next.set(engineerID, { displayText: initialText, updatedAt: ctrl.getUpdatedAt() })
      }
      return next
    })
    return ctrl
  }

  // Drive dwell controllers whenever engineer progressText changes
  createEffect(() => {
    const engineers = team().engineers
    const seenIDs = new Set<string>()
    for (const eng of engineers) {
      seenIDs.add(eng.engineerID)
      const ctrl = ensureController(eng.engineerID, eng.progressText)
      ctrl.push(eng.progressText)
    }
    // Dispose controllers for engineers no longer in the list
    for (const [id, ctrl] of controllers) {
      if (!seenIDs.has(id)) {
        ctrl.dispose()
        controllers.delete(id)
        setDisplayMap((prev) => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      }
    }
  })

  // Animate spinner frame and advance tick for activity-window re-evaluation
  onMount(() => {
    const spinnerInterval = setInterval(() => {
      setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length)
    }, 80)
    const tickInterval = setInterval(() => {
      setTick((t) => t + 1)
    }, 1000)
    onCleanup(() => {
      clearInterval(spinnerInterval)
      clearInterval(tickInterval)
      // Dispose all remaining controllers
      for (const ctrl of controllers.values()) ctrl.dispose()
      controllers.clear()
    })
  })

  const spinner = () => SPINNER_FRAMES[spinnerIdx()]

  // Recency-based activity: show spinner if progressText was updated recently
  function isActive(engineerID: string): boolean {
    void tick() // subscribe to tick so this re-evaluates every 1 s
    const entry = displayMap().get(engineerID)
    if (!entry?.displayText) return false
    return Date.now() - entry.updatedAt < ACTIVITY_WINDOW_MS
  }

  const working = createMemo(() => {
    void tick() // re-evaluate when tick changes
    return team().engineers.filter((e) => isActive(e.engineerID)).length
  })

  const dot = (engineerID: string, state: string) => {
    if (isActive(engineerID)) return theme().success
    if (state === "working") return theme().success
    if (state === "blocked") return theme().warning
    if (state === "failed") return theme().error
    return theme().textMuted
  }

  const stateLabel = (state: string) => {
    if (state === "working") return "Working"
    if (state === "blocked") return "Blocked"
    if (state === "failed") return "Failed"
    if (state === "idle") return "Idle"
    return state
  }

  return (
    <Show when={active()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Team</b>
            <Show when={!open()}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({team().engineers.length}{working() > 0 ? `, ${working()} active` : ""}{failed() > 0 ? `, ${failed()} failed` : ""})
              </span>
            </Show>
          </text>
        </box>
        <Show when={open()}>
          <For each={team().engineers}>
            {(eng) => {
              const entry = () => displayMap().get(eng.engineerID)
              const displayText = () => entry()?.displayText
              const active = () => isActive(eng.engineerID)
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => {
                    if (eng.sessionID) {
                      props.api.route.navigate("session", { sessionID: eng.sessionID })
                    }
                  }}
                >
                  <text
                    flexShrink={0}
                    style={{ fg: dot(eng.engineerID, eng.state) }}
                  >
                    {active() ? spinner() : "•"}
                  </text>
                  <text fg={eng.agentColor || getEngineerColor(eng.name, eng.agentName)} wrapMode="word">
                    {eng.name}
                    <Show when={eng.agentName}>
                      <span style={{ fg: theme().textMuted }}> ({eng.agentName})</span>
                    </Show>
                    {" "}
                    <span style={{ fg: theme().textMuted }}>
                      <Switch fallback={stateLabel(eng.state)}>
                        <Match when={displayText()}>
                          {displayText()}
                        </Match>
                        <Match when={eng.state === "working" && eng.currentTask}>
                          Working on {eng.currentTask}
                        </Match>
                        <Match when={eng.state === "idle"}>Idle</Match>
                        <Match when={eng.state === "failed"}>Failed</Match>
                        <Match when={eng.state === "blocked"}>Blocked</Match>
                      </Switch>
                    </span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
