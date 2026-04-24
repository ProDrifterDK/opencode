import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/dialog-model"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  // Team status
  const teamActive = createMemo(() => sync.data.team.record !== null)
  const engineers = createMemo(() => sync.data.team.engineers)
  const workingCount = createMemo(() => engineers().filter((e) => e.state === "working").length)
  const blockedCount = createMemo(() => engineers().filter((e) => e.state === "blocked").length)
  const failedCount = createMemo(() => engineers().filter((e) => e.state === "failed").length)
  const idleCount = createMemo(() => engineers().filter((e) => e.state === "idle").length)
  const completedCount = createMemo(() => engineers().filter((e) => e.state === "completed").length)

  // Spinner animation for working engineers
  const [spinnerIdx, setSpinnerIdx] = createSignal(0)
  onMount(() => {
    const interval = setInterval(() => {
      if (workingCount() > 0) {
        setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length)
      }
    }, 80)
    onCleanup(() => clearInterval(interval))
  })
  const spinner = () => SPINNER_FRAMES[spinnerIdx()]

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <Show when={teamActive()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={workingCount() > 0}>
                    <span style={{ fg: theme.success }}>{spinner()}</span>
                  </Match>
                  <Match when={blockedCount() > 0}>
                    <span style={{ fg: theme.warning }}>◆</span>
                  </Match>
                  <Match when={failedCount() > 0}>
                    <span style={{ fg: theme.error }}>◆</span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.textMuted }}>◆</span>
                  </Match>
                </Switch>
                {" "}
                <Switch>
                  <Match when={workingCount() > 0}>
                    <span style={{ fg: theme.success }}>{workingCount()}</span> Working
                    <Show when={completedCount() > 0}>
                      <span style={{ fg: theme.textMuted }}> · {completedCount()} done</span>
                    </Show>
                  </Match>
                  <Match when={blockedCount() > 0}>
                    <span style={{ fg: theme.warning }}>{blockedCount()}</span> Blocked
                  </Match>
                  <Match when={failedCount() > 0}>
                    <span style={{ fg: theme.error }}>{failedCount()}</span> Failed
                  </Match>
                  <Match when={completedCount() > 0}>
                    <span style={{ fg: theme.success }}>✓</span> {completedCount()} Complete
                  </Match>
                  <Match when={idleCount() > 0}>
                    {idleCount()} Idle
                  </Match>
                  <Match when={true}>
                    Team
                  </Match>
                </Switch>
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
