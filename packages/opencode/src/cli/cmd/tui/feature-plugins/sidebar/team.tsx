import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Match, Show, Switch, createSignal } from "solid-js"

const id = "internal:sidebar-team"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const team = createMemo(() => props.api.state.team())
  const active = createMemo(() => team().record !== null)
  const working = createMemo(() => team().engineers.filter((e) => e.state === "working").length)
  const failed = createMemo(() => team().engineers.filter((e) => e.state === "failed").length)

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
                  •
                </text>
                <text fg={theme().text} wrapMode="word">
                  {eng.name}{" "}
                  <span style={{ fg: theme().textMuted }}>
                    <Switch fallback={stateLabel(eng.state)}>
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
