// relay fleet view for the OpenCode TUI (0047; workspace scope 0048).
//
// Surfaces (user rulings 2026-11-15):
// - a compact strip appended to sidebar.content: one row per relay
//   group OF THE CURRENT WORKSPACE, visible from every primary
//   session of that workspace; clicking a group row opens the fleet
//   panel scoped to that group, clicking the header opens all;
// - a selectable side panel (slash /fleet, panel name "relay.fleet")
//   listing the workspace's line-holding sessions as sections, one
//   section per relay group, plus a trailing "未挂线" section with
//   the workspace's lineless PRIMARY sessions - idle primaries are
//   reachable and switchable too (0048); Enter switches to the
//   owner session via tabs.focus when session tabs are enabled,
//   router.navigate otherwise (auto-fit ruling); "a" expands a
//   single-group view back to all groups.
//
// Workspace scope (0048): a group is visible from every primary
// session of its workspace, worktrees included. The workspace key
// is the git common dir (worktrees of one repo share it), computed
// per directory during the poll and cached; a dir without git falls
// back to exact normalized-path match. The ANCHOR - which workspace
// the view is about - is the VIEWING session's own location
// (session.get(sessionID).location.directory; app location only as
// a fallback), so a TUI never inherits another project's default.
// Unknown key = empty view, never other workspaces' rows.
//
// Busy semantics (0049, user ruling 2026-11-15): a session shows
// busy when ITSELF running or ANY descendant is running - background
// subagents included; "idle" means no work at all. The old
// unseen-output rule (busy > viewed) no longer marks busy - the
// daemon's per-line busy bit is ignored for the dot (0049 fix).
// Running comes from the HOST's execution state,
// context.data.session.status(id) === "running" - the same signal
// the TUI itself renders. Timestamps cannot carry this: a finished
// background subagent ends with its final report write bumping busy
// AFTER the last idle (busy > idle forever; live evidence
// 2026-11-15: T-G03 outcome=succeeded yet busy > idle, a month-old
// explore session still hot), and a session blocked in a long tool
// call - relay ask_user waits on a human for hours - freezes
// time.updated while its agent loop still runs (the user's
// all-idle report). Hosts without status() fall back to
// busy > idle + 5-min freshness (FRESH_MS) - misreads both classes,
// kept only for old builds.
//
// Data: relay daemon /api/state, re-reading ~/.relay/lock.json and
// the token file on every poll (port-drift discipline). The daemon
// already computes per-line busy and attended_age, so this part is
// read-only and daemon-version agnostic. Daemon unreachable degrades
// to a quiet notice - it must never take the TUI down.
//
// Mouse: onMouseDown on strip rows asks for click-to-open; slot JSX
// mouse events are undocumented, so arrows + Enter stay the primary
// face - a dead handler is silently ignored (0047 fog).
import { Plugin } from "@opencode/plugin/tui"
import { Show, For, createSignal } from "solid-js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const FLEET = "relay.fleet"

// Legacy fallback window for hosts without session.status(): a
// busy-looking session (busy > idle) whose last update is older
// than this reads idle (0049 zombie evidence).
const FRESH_MS = 300_000

type LineRow = {
  name: string
  group: string
  project: string
  ws: string
  owner: string
  owner_title: string
  busy: boolean
  attended_age: number | null
}

type Fleet = {
  ok: boolean
  order: string[]
  groups: Record<string, LineRow[]>
  solo: LineRow[]
}

const EMPTY: Fleet = {
  ok: false, order: [], groups: {}, solo: [],
}

function normDir(p: string): string {
  return path.resolve(p).toLowerCase()
    .replace(/[\\/]+$/, "").replace(/\\/g, "/")
}

// Workspace identity (0048): the git common dir - worktrees of one
// repo share it, so a group opened from a worktree shows up in the
// main checkout's view and vice versa. Non-git dirs fall back to
// their own normalized path (exact match only). Cached per dir;
// --path-format=absolute needs git >= 2.31, older git degrades to
// the same fallback via the catch.
// CAREFUL: promisified execFile resolves {stdout, stderr} - reading
// it as a string collapses EVERY key to "[object Object]" and every
// workspace matches every other (the round-3 leak, fixed 2026-11-15).
const runGit = promisify(execFile)
const wsCache = new Map<string, string>()
async function workspaceKey(dir: string): Promise<string> {
  if (!dir) return ""
  const norm = normDir(dir)
  const hit = wsCache.get(norm)
  if (hit !== undefined) return hit
  let key = norm
  try {
    const out = await runGit("git", ["-C", dir, "rev-parse",
      "--path-format=absolute", "--git-common-dir"],
      { timeout: 2000, windowsHide: true })
    const s = String(out?.stdout ?? "").trim()
    if (s) key = normDir(s)
  } catch {}
  wsCache.set(norm, key)
  return key
}

async function readFleet(): Promise<Fleet> {
  const home = os.homedir()
  const lock = JSON.parse(fs.readFileSync(
    path.join(home, ".relay", "lock.json"), "utf8"))
  const token = fs.readFileSync(
    path.join(home, ".relay", "token"), "utf8").trim()
  const res = await fetch(
    "http://127.0.0.1:" + lock.port
    + "/api/state?token=" + encodeURIComponent(token))
  if (!res.ok) throw new Error("relay daemon " + res.status)
  const st: any = await res.json()
  const dirs = [...new Set((st.lines || [])
    .map((l: any) => l.project || ""))]
  await Promise.all(dirs.map((d) => workspaceKey(d)))
  const groups: Record<string, LineRow[]> = {}
  for (const l of st.lines || []) {
    const row: LineRow = {
      ...l,
      ws: wsCache.get(normDir(l.project || "")) || "",
    }
    if (!groups[row.group]) groups[row.group] = []
    groups[row.group].push(row)
  }
  const known: Record<string, any> = st.line_groups || {}
  const order = Object.keys(known).sort(
    (a, b) => (known[a].founded_at || 0)
      - (known[b].founded_at || 0))
  for (const g of Object.keys(groups)) {
    if (!order.includes(g)) order.push(g)
  }
  return { ok: true, order, groups, solo: [] }
}

function flatRows(f: Fleet): Array<{ group: string; row: LineRow }> {
  const out: Array<{ group: string; row: LineRow }> = []
  for (const g of f.order) {
    for (const row of f.groups[g] || []) out.push({ group: g, row })
  }
  return out
}

function agoText(age: number | null): string {
  if (age == null) return ""
  if (age < 90) return " · 刚看过"
  return " · 已看 " + Math.round(age / 60) + " 分前"
}

export default Plugin.define({
  id: "relay.fleet",
  setup(context) {
    const [fleet, setFleet] = createSignal<Fleet>(EMPTY)
    const [focusGroup, setFocusGroup] = createSignal<string | undefined>(
      undefined)
    let alive = true

    // The workspace key of the session a view is anchored to. The
    // session's own location decides (0048; live shape confirmed on
    // the service API: rows carry location.directory, parentID and
    // time.busy/viewed); the app location is only a fallback. get()
    // may be a plain value or a promise depending on host build, so
    // anchors warm through Promise.resolve in the background and
    // reads are sync cache hits; an unknown anchor yields "" which
    // matches nothing - fail-closed, the view stays empty rather
    // than leak another workspace (fills in within one poll, ~3s).
    const anchorDirs = new Map<string, string>()
    function anchorWarm(sid: string) {
      Promise.resolve().then(async () => {
        try {
          const got: any =
            (context as any).data.session.get(sid)
          const s: any = await Promise.resolve(got)
          let dir = s?.location?.directory || ""
          if (!dir) {
            const l: any = (context as any).location
            if (typeof l?.directory === "string") {
              dir = l.directory
            }
          }
          if (dir) await workspaceKey(dir)
          anchorDirs.set(sid, dir)
        } catch { anchorDirs.set(sid, "") }
      })
    }
    function anchorKey(sid?: string): string {
      if (!sid) {
        const l: any = (context as any).location
        const d = typeof l?.directory === "string"
          ? l.directory : ""
        return d ? wsCache.get(normDir(d)) || "" : ""
      }
      if (!anchorDirs.has(sid)) {
        anchorWarm(sid)
        return ""
      }
      const dir = anchorDirs.get(sid) || ""
      return dir ? wsCache.get(normDir(dir)) || "" : ""
    }

    // Legacy fallback (hosts without session.status): busy > idle
    // AND active within FRESH_MS - misreads finished subagents
    // (busy post-bumped by the report write) as hot until stale,
    // and long-blocked tool calls as idle after FRESH_MS.
    function isRunning(s: any): boolean {
      const t = s?.time
      if (!t || typeof t.busy !== "number") return false
      if (!(t.busy > (typeof t.idle === "number" ? t.idle : 0))) {
        return false
      }
      if (typeof t.updated !== "number") return true
      return Date.now() - t.updated < FRESH_MS
    }
    // Hot-session semantics (0049): running = the host's own
    // execution state, session.status(id) === "running" -
    // authoritative for both zombie subagents and sessions blocked
    // in long tool calls; timestamp fallback only for old builds.
    // A running session propagates "hot" up its parentID chain
    // (bounded walk), so a primary waiting on background subagents
    // shows busy too.
    function collectHot(): Set<string> {
      try {
        const data: any = (context as any).data
        const list: any[] = data.session.list() || []
        const hasStatus = typeof data.session.status === "function"
        const parentOf = new Map<string, string>()
        const running: string[] = []
        for (const s of list) {
          if (!s?.id) continue
          if (s.parentID) parentOf.set(s.id, s.parentID)
          const r = hasStatus
            ? data.session.status(s.id) === "running"
            : isRunning(s)
          if (r) running.push(s.id)
        }
        const hot = new Set<string>(running)
        for (const id of running) {
          let cur = parentOf.get(id)
          let hops = 0
          while (cur && hops < 64) {
            hot.add(cur)
            cur = parentOf.get(cur)
            hops += 1
          }
        }
        return hot
      } catch { return new Set<string>() }
    }
    // Lineless primary sessions (0048): read the host session cache,
    // keep parentless sessions that carry a location (needed for
    // scoping), drop line holders (they already sit in their group
    // sections). busy = hot (self or descendants running, 0049).
    async function soloRows(holders: Set<string>,
                            hot: Set<string>): Promise<LineRow[]> {
      try {
        const list: any[] =
          (context as any).data.session.list() || []
        const rows: any[] = list.filter((s: any) =>
          s && !s.parentID && s.id && !holders.has(s.id)
          && s?.location?.directory)
        await Promise.all(rows.map((s: any) =>
          workspaceKey(s.location.directory)))
        const out: LineRow[] = []
        for (const s of rows) {
          out.push({
            name: s.title || "未命名会话",
            group: "__solo__",
            project: s.location.directory,
            ws: wsCache.get(normDir(s.location.directory)) || "",
            owner: s.id,
            owner_title: s.agent || "",
            busy: hot.has(s.id),
            attended_age: null,
          })
        }
        return out
      } catch { return [] }
    }
    async function tick() {
      try {
        const next = await readFleet()
        const hot = collectHot()
        const holders = new Set<string>()
        for (const g of Object.keys(next.groups)) {
          for (const r of next.groups[g]) {
            holders.add(r.owner)
            // Hot-only (0049): the daemon's unseen-output busy no
            // longer lights the dot - set it both ways, not OR.
            r.busy = hot.has(r.owner)
          }
        }
        next.solo = await soloRows(holders, hot)
        const l: any = (context as any).location
        if (typeof l?.directory === "string" && l.directory) {
          await workspaceKey(l.directory) // fallback anchor warm
        }
        if (alive) setFleet(next)
      } catch {
        if (alive) setFleet(EMPTY)
      }
    }
    tick()
    const timer = setInterval(tick, 3000)

    // Ride the proven re-render path (upstream #59458: slot JSX does
    // not re-render on cursor/signal-only changes - rows follow only
    // when the fleet object identity changes, as the poll proves).
    function nudge() { setFleet((f) => ({ ...f })) }

    // Command registers DIRECTLY in setup: keymap.layer is callable
    // from setup per the docs, while the docs' app-slot pattern
    // silently no-ops on opencode <= 2.3.0 (binary autopsy 2026-11-15;
    // note findstr MISS is NOT proof of absence - sidebar.content is
    // bundled compressed, yet the strip renders live on 2.3.0).
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "relay.fleet.open",
        title: "relay 舰队视图",
        slash: { name: "fleet" },
        palette: true,
        run: () => {
          setFocusGroup(undefined) // /fleet = all workspace groups
          nudge()
          context.ui.panel.open(FLEET)
        },
      }],
    }))

    // Workspace view (0048): every group whose lines share the
    // anchor's workspace key - worktrees included. key "" (anchor
    // unknown) shows nothing.
    function viewOf(key: string): Fleet {
      const f = fleet()
      const order = key
        ? f.order.filter((g) =>
            (f.groups[g] || []).some((r) => r.ws === key))
        : []
      const groups: Record<string, LineRow[]> = {}
      for (const g of order) groups[g] = f.groups[g] || []
      const solo = key
        ? (f.solo || []).filter((r) => r.ws === key)
        : []
      return { ok: f.ok, order, groups, solo }
    }

    // Compact strip: one row per workspace group; clicking a row
    // opens the panel scoped to that group, the header opens all
    // (onMouseDown is undocumented on slot JSX - a host without
    // mouse support ignores it silently).
    context.ui.slot({
      append: "sidebar.content",
      render: (s: { sessionID?: string }) => {
        const v = viewOf(anchorKey(s.sessionID))
        return (
          <Show when={v.order.length > 0}>
            <box>
              <text fg={context.theme.text.muted}
                onMouseDown={() => {
                  setFocusGroup(undefined)
                  nudge()
                  context.ui.panel.open(FLEET)
                }}>
                relay · {v.order.length} 组</text>
              <For each={v.order}>{(g) => {
                const rows = v.groups[g] || []
                const busy = rows.filter((r) => r.busy).length
                return (
                  <text fg={busy > 0
                    ? context.theme.text.base
                    : context.theme.text.muted}
                    onMouseDown={() => {
                      setFocusGroup(g)
                      nudge()
                      context.ui.panel.open(FLEET)
                    }}>
                    {"  "}{g} {busy}/{rows.length}
                    {busy > 0 ? " busy" : " idle"}
                  </text>
                )
              }}</For>
            </box>
          </Show>
        )
      },
    })

    // Fleet side panel: sections per relay group, selectable,
    // keyboard first. focusGroup (strip click) narrows to one group;
    // "a" expands back to all workspace groups.
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === FLEET}>
          <FleetPanel ctx={context} setFleet={setFleet}
            focusGroup={focusGroup} setFocusGroup={setFocusGroup}
            panel={panel} />
        </Show>
      ),
    })

    function FleetPanel(props: {
      ctx: any
      setFleet: (fn: (f: Fleet) => Fleet) => void
      focusGroup: () => string | undefined
      setFocusGroup: (g: string | undefined) => void
      panel: any
    }) {
      const ctx = props.ctx
      const [cursor, setCursor] = createSignal(0)
      const view = () => viewOf(anchorKey(props.panel.sessionID))
      const view2 = () => {
        const v = view()
        const fg = props.focusGroup()
        const order = fg
          ? v.order.filter((g) => g === fg)
          : v.order
        const groups: Record<string, LineRow[]> = {}
        for (const g of order) groups[g] = v.groups[g] || []
        return { ...v, order, groups }
      }
      // Rows-only sequence for the cursor: group rows first, then -
      // in the all-groups view - the lineless primary sessions.
      const flat = () => {
        const rows = flatRows(view2()).map((e) => e.row)
        if (!props.focusGroup()) {
          for (const r of view2().solo || []) rows.push(r)
        }
        return rows
      }
      // Section-aware render list: a header per group between rows;
      // the cursor indexes into the rows-only sequence (headers are
      // not selectable). flat() and items() derive from the same
      // view2(), so their orders always agree.
      type Item = { kind: "header"; group: string } | {
        kind: "row"; row: LineRow; idx: number
      }
      const items = (): Item[] => {
        const out: Item[] = []
        let i = 0
        for (const g of view2().order) {
          out.push({ kind: "header", group: g })
          for (const r of view2().groups[g] || []) {
            out.push({ kind: "row", row: r, idx: i })
            i += 1
          }
        }
        if (!props.focusGroup()) {
          const solo = view2().solo || []
          if (solo.length > 0) {
            out.push({ kind: "header", group: "未挂线" })
            for (const r of solo) {
              out.push({ kind: "row", row: r, idx: i })
              i += 1
            }
          }
        }
        return out
      }
      function move(d: number) {
        const n = Math.max(flat().length - 1, 0)
        setCursor((c) => Math.max(0, Math.min(c + d, n)))
        // #59458 workaround: rebuild identity so the rows follow now.
        props.setFleet((f) => ({ ...f }))
      }
      function switchTo(row?: LineRow) {
        if (!row || !row.owner) return
        if (ctx.ui.tabs.enabled()) {
          ctx.ui.tabs.focus(row.owner)
        } else {
          ctx.ui.router.navigate(
            { type: "session", sessionID: row.owner })
        }
      }
      ctx.keymap.layer(() => ({
        commands: [
          { id: "relay.fleet.down", bind: "down", run: () => move(1) },
          { id: "relay.fleet.up", bind: "up", run: () => move(-1) },
          { id: "relay.fleet.switch", bind: "return",
            run: () => switchTo(flat()[cursor()]) },
          { id: "relay.fleet.fullscreen", bind: "f",
            run: () => props.panel.toggleFullscreen() },
          { id: "relay.fleet.all", bind: "a",
            run: () => {
              props.setFocusGroup(undefined)
              props.setFleet((f) => ({ ...f }))
            } },
          { id: "relay.fleet.close", bind: "escape",
            run: () => props.panel.close() },
        ],
      }))
      return (
        <box>
          <text fg={ctx.theme.text.muted}>
            relay 舰队 · ↑↓ 选择 · Enter 切换 · f 全屏 · a 全部组
            · Esc 关闭</text>
          <Show when={view().ok} fallback={
            <text fg={ctx.theme.text.muted}>
              relay daemon 不可达(未运行或端口漂移中,3 秒后自动重试)
            </text>
          }>
            <Show when={flat().length > 0} fallback={
              <text fg={ctx.theme.text.muted}>
                当前工作区无 relay 线路
              </text>
            }>
              <For each={items()}>{(it) => it.kind === "header"
                ? (
                  <text fg={ctx.theme.text.muted}>
                    {"── "}{it.group}{" ──"}</text>
                )
                : (
                  <text fg={it.idx === cursor()
                    ? ctx.theme.text.base
                    : ctx.theme.text.muted}>
                    {it.idx === cursor() ? "▸ " : "  "}
                    {it.row.busy ? "●" : "○"}
                    {" "}{it.row.name}
                    {" "}{(it.row.owner || "").slice(-8)}
                    {it.row.owner_title
                      ? " · " + it.row.owner_title : ""}
                    {it.row.busy ? " · busy" : " · idle"}
                    {agoText(it.row.attended_age)}
                  </text>
                )
              }</For>
            </Show>
          </Show>
        </box>
      )
    }

    return () => {
      alive = false
      clearInterval(timer)
    }
  },
})
