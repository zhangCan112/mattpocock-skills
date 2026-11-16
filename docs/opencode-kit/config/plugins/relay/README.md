# opencode-relay-plugin

OpenCode plugin that owns the relay daemon lifecycle: probe the
shared workspace's `lock.json`, spawn `relay/daemon.py --daemon
--workspace <dir>` when no live daemon holds it, register the relay
MCP server (remote URL + Bearer token + `X-Relay-Project` header),
and self-heal (probe → respawn → `mcp.reload()`) when a relay tool
errors mid-session.

Zero npm dependencies. Decision logic is exported as pure functions
(`parseLock`, `planAction`, `relayServerConfig`, `isRelayTool`,
`pickRoot`, `resolveDaemonHome`, `resolveWorkspace`) and pinned by
`relay/tests/` via a node harness.

## 0047: TUI fleet view (`./tui` export)

The package also ships a TUI part (`./tui` → `tui.tsx`), loaded
automatically beside the server part by opencode v2's TUI:

- **sidebar strip** — a compact always-on block in the session
  sidebar: one row per relay group of the CURRENT WORKSPACE
  (worktrees included, matched by git common dir; non-git dirs
  exact-match) with `busy/total`; clicking a group row opens the
  panel scoped to that group, clicking the header opens all (mouse
  on slot JSX is undocumented in the host — a build without it
  ignores the handler silently);
- **fleet panel** — `/fleet` (or palette "relay 舰队视图") opens a
  side panel of the workspace's sessions sectioned by relay group
  (header row per group), plus a trailing 未挂线 section with the
  workspace's lineless primary sessions; rows carry ● busy / ○ idle
  (0049: busy = the session itself running OR any descendant
  running, background subagents included; unread daemon output no
  longer counts. Running comes from the host's own execution state
  (session.status === "running") — timestamps can't carry it: a
  finished subagent's final report write leaves busy > idle
  forever, and a session blocked in a long tool call (relay
  ask_user waits on a human for hours) freezes time.updated while
  its agent loop still runs; hosts without status() fall back to
  busy > idle + 5-min freshness), owner 尾8·title, and
  freshness; ↑↓ select, Enter switches to the owner
  session (tabs.focus when session tabs are enabled,
  router.navigate otherwise), `f` fullscreen, `a` expands a
  single-group view back to all, Esc close.

Read-only against the daemon's `/api/state`; re-reads
`~/.relay/lock.json` + token every poll (port-drift discipline).
Daemon unreachable degrades to a quiet notice. Scope ruling (0048,
2026-11-15): workspace level — every group of the current
workspace, worktrees included, is visible from any of its primary
sessions; other workspaces' groups never appear; lineless primary
sessions get their own section so idle ones can be reopened.

## 0030: one global daemon, every checkout

Each project's opencode loads its own plugin instance; every instance
resolves the SAME shared workspace, so all projects converge on one
daemon (first instance up spawns it; the lock's yield protocol keeps
it single). Each instance stamps its checkout
(`ctx.location.directory`) into the MCP registration headers, so
tickets know which project they came from (panel chip, per-request
file anchoring).

## Layouts

Two roots are resolved independently:

**daemonHome** — the directory that must contain `relay/daemon.py`:

1. `RELAY_ROOT` environment variable (checked first).
2. Dev layout — source at `<repo>/relay/plugin/index.js`, root is
   two levels up.
3. Copy-installed layout — plugin at
   `<project>/.opencode/plugins/relay/index.js`, root is three
   levels up (`relay/` must sit at that root).
4. Self-contained global install — `<plugins>/relay/index.js` with
   `relay/` copied INSIDE it; the plugin dir itself is the root.

**workspace** — the daemon's shared state dir (lock/token/audit/
pending/log):

1. `RELAY_HOME` environment variable (checked first).
2. `~/.relay` (the default; created by the daemon on first spawn).

## Install

**Global self-contained (0030 recommended):** copy to
`~/.config/opencode/plugins/relay/` — the folder must contain
`package.json`, `index.js`, this README, and a `relay/` subfolder
with `daemon.py` + `server_common.py` + `vendor/marked.min.js`
(the viewer's rendering engine) inside. The plugin then works
in every project with zero env config. If the global plugins dir is
not auto-loaded by your build, reference it from the global
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["~/.config/opencode/plugins/relay"]
}
```

**Config reference (dev, this repo):** point `plugins` at the source
directory — project-local `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./relay/plugin"]
}
```

Set `RELAY_HOME` to give a dev checkout a private workspace instead
of sharing `~/.relay`.

The opencode config path is for INSTALLS only — never develop there
(the source of truth is this repo's `relay/plugin/` directory).
