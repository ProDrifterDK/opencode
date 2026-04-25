import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Match, Show, Switch, createSignal, onMount, onCleanup } from "solid-js"

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

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const [spinnerIdx, setSpinnerIdx] = createSignal(0)
  const theme = () => props.api.theme.current
  const team = createMemo(() => props.api.state.team())
  const active = createMemo(() => team().record !== null)
  const working = createMemo(() => team().engineers.filter((e) => e.state === "working").length)
  const failed = createMemo(() => team().engineers.filter((e) => e.state === "failed").length)

  // Animate spinner when engineers are working
  onMount(() => {
    const interval = setInterval(() => {
      if (working() > 0) {
        setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length)
      }
    }, 80)
    onCleanup(() => clearInterval(interval))
  })

  const spinner = () => SPINNER_FRAMES[spinnerIdx()]

  const dot = (state: string) => {
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
            {(eng) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{ fg: dot(eng.state) }}
                >
                  {eng.state === "working" ? spinner() : "•"}
                </text>
                <text fg={eng.agentColor || getEngineerColor(eng.name, eng.agentName)} wrapMode="word">
                  {eng.name}
                  <Show when={eng.agentName}>
                    <span style={{ fg: theme().textMuted }}> ({eng.agentName})</span>
                  </Show>
                  {" "}
                  <span style={{ fg: theme().textMuted }}>
                    <Switch fallback={stateLabel(eng.state)}>
                      <Match when={eng.progressText}>
                        {eng.progressText}
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
            )}
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
