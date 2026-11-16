// relay autostart plugin (issue 0021; relocated to relay/plugin/ in
// 0029 — the opencode config path holds INSTALLS, never dev source).
//
// Owns the relay daemon lifecycle for this checkout:
//   * on plugin load (OpenCode server start / config reload): probe
//     the shared workspace's lock.json, spawn the daemon when no live
//     daemon holds it, then register the relay MCP server through the
//     mcp transform. Daemon strictly BEFORE config: a config entry for
//     a dead daemon gets cached as failed and needs a content change to
//     reconnect (spike lesson, DESIGN.md §6).
//   * on a relay tool execution error (daemon died mid-session):
//     probe/respawn, then ctx.mcp.reload() to reconnect. Pairs with
//     the agent-side transport-error retry guidance delivered in 0019.
//
// 0030: ONE global daemon serves every checkout. Each project's plugin
// instance resolves (a) daemonHome — where daemon.py lives — and (b)
// workspaceDir — the shared state dir (~/.relay, RELAY_HOME overrides);
// all instances converge on the same lock file, first one up wins.
// The instance stamps its checkout (ctx.location.directory) into the
// MCP registration headers (X-Relay-Project) so tickets know their
// project.
//
// Source lives in the repo at relay/plugin/ (inside the relay
// deliverable it serves; 0029: the opencode config path holds INSTALLS,
// never dev source). Supported daemonHome layouts, resolved by
// resolveDaemonHome() below; RELAY_ROOT overrides all (global installs
// pointing at one shared checkout).
//
// Pure decision helpers are named exports (seams for
// relay/tests/test_plugin_autostart.py); importing this module has no
// side effects.
import { spawn } from 'node:child_process'
import { connect as tcpConnect } from 'node:net'
import { appendFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_NAME = 'relay'
const START_TIMEOUT_MS = 15000
const POLL_MS = 250
const HEAL_MIN_INTERVAL_MS = 5000
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

// --- pure seams -------------------------------------------------------

/** Ordered daemon-home candidates -> first one that actually has
 * relay/daemon.py wins (per the exists predicate); the first candidate
 * is the fallback so failures surface with familiar paths. Dev
 * layout: <repo>/relay/plugin/index.js (root two up). Copy-installed
 * layout: <project>/.opencode/plugins/relay/index.js (root three up,
 * relay/ copied next to the target project). Self-contained global
 * install: <plugins>/relay/index.js with relay/ copied INSIDE it (the
 * plugin dir itself is the root — 0030). */
export function pickRoot(candidates, exists) {
  const hasDaemon = (dir) => exists(join(dir, 'relay', 'daemon.py'))
  return candidates.find(hasDaemon) || candidates[0]
}

/** Plugin module URL -> the daemon home this plugin spawns from. */
export function resolveDaemonHome(importUrl, env = process.env) {
  if (env.RELAY_ROOT) return env.RELAY_ROOT
  const here = dirname(fileURLToPath(importUrl))
  return pickRoot(
    [join(here, '..', '..'), join(here, '..', '..', '..'), here],
    (p) => existsSync(p),
  )
}

/** Env (+ injected home, a test seam) -> the shared relay workspace
 * (0030): lock/token/audit/log for the ONE global daemon. RELAY_HOME
 * overrides the ~/.relay default. The plugin never creates it — the
 * daemon's ensure_workspace does, on first spawn. */
export function resolveWorkspace(env = process.env, home = homedir()) {
  if (env.RELAY_HOME) return env.RELAY_HOME
  return join(home, '.relay')
}

/** lock.json text -> {pid, port} | null. Corrupt/half-written reads
 * as "no lock"; never raises. daemon.py writes plain ints. */
export function parseLock(text) {
  if (typeof text !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { pid, port } = parsed
  if (!Number.isInteger(pid) || !Number.isInteger(port)) return null
  if (pid <= 0 || port <= 0) return null
  return { pid, port }
}

/** {hasLock, pidAlive} -> 'use' | 'start'. A lock whose pid is dead
 * (crash) is as good as no lock: both mean "start a daemon". */
export function planAction({ hasLock, pidAlive }) {
  return hasLock && pidAlive ? 'use' : 'start'
}

/** {port, token} + project -> MCP server config for editor.set().
 * Mirrors the proven manual block from the machine-local
 * opencode.json byte for byte in shape: remote URL on the lock port,
 * Bearer token header, oauth off, 10s startup timeout. ``project``
 * (0030) rides along as X-Relay-Project so every tool call tells the
 * daemon which checkout it came from; empty keeps the legacy shape. */
export function relayServerConfig({ port, token }, project = '') {
  const headers = { Authorization: 'Bearer ' + token }
  if (project) headers['X-Relay-Project'] = project
  return {
    type: 'remote',
    url: 'http://127.0.0.1:' + port + '/mcp',
    headers,
    oauth: false,
    timeout: { startup: 10001 },
  }
}

/** Effective tool id -> is it a relay tool? MCP tools carry the
 * server-name prefix ('relay_ask_user'); the bare name is accepted too
 * so a client-side naming change cannot silently disarm self-heal.
 * The bare server name itself is not a tool. */
export function isRelayTool(name) {
  return name === 'ask_user' || name.startsWith('relay_')
}

// --- impure helpers ---------------------------------------------------

// 0030: where daemon.py lives, and the shared state dir every
// checkout's plugin instance converges on (see header comment).
const DAEMON_HOME = resolveDaemonHome(import.meta.url)
const WORKSPACE = resolveWorkspace()

// Plugin stdout does not reach opencode.log, so troubleshooting state
// lands in the runtime workspace instead (same place the daemon keeps
// server.log). Explicit \n keeps the file LF-only on every platform.
// Early lines may be lost before the daemon's first spawn creates the
// workspace — acceptable for a troubleshooting log.
function logPlugin(line) {
  console.log('[relay-autostart] ' + line)
  appendFile(
    join(WORKSPACE, 'plugin.log'),
    '[' + new Date().toISOString() + '] ' + line + '\n',
  ).catch(() => {})
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM/EACCES: process exists but is not ours -> alive.
    return err && (err.code === 'EPERM' || err.code === 'EACCES')
  }
  return true
}

/** TCP connect says "something is listening on the lock port". Used
 * instead of HTTP: a Streamable HTTP GET on /mcp can legally hang
 * open as an SSE stream, which a timeout cannot tell from refusal. */
function tcpUp(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = tcpConnect(port, '127.0.0.1')
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function readToken(workspace) {
  try {
    const text = await readFile(join(workspace, 'token'), 'utf8')
    const token = text.trim()
    return token || null
  } catch {
    return null
  }
}

async function probe(workspace) {
  let text
  try {
    text = await readFile(join(workspace, 'lock.json'), 'utf8')
  } catch {
    return { hasLock: false }
  }
  const lock = parseLock(text)
  if (!lock) return { hasLock: false }
  return { hasLock: true, lock, pidAlive: pidAlive(lock.pid) }
}

/** `daemon.py --daemon --workspace <dir>` self-detaches (the spawned
 * parent exits 0 once the real server holds the lock; an
 * already-running daemon makes the child yield). So a plain spawn +
 * exit-code check is all the plugin needs, and re-spawning while alive
 * is harmless. 0030: the workspace rides on the command line so every
 * checkout's instance converges on the same state dir. */
function spawnDaemon(daemonHome, workspace) {
  return new Promise((resolve) => {
    const child = spawn(
      PYTHON,
      [join(daemonHome, 'relay', 'daemon.py'), '--daemon',
        '--workspace', workspace],
      { cwd: daemonHome, stdio: 'ignore', windowsHide: true },
    )
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

// Latest confirmed {port, token}; the mcp transform reads it at replay
// time, so a respawn on a new port is picked up by ctx.mcp.reload().
let lastKnown = null

async function doEnsure(daemonHome, workspace) {
  const p = await probe(workspace)
  const action = planAction(p)
  if (action === 'start') {
    logPlugin('no live daemon; spawning relay/daemon.py --daemon')
    if (!(await spawnDaemon(daemonHome, workspace))) {
      logPlugin('spawn failed; is ' + PYTHON + ' on PATH?')
      return null
    }
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      const q = await probe(workspace)
      if (planAction(q) === 'use' && (await tcpUp(q.lock.port))) break
    }
  }
  const q = await probe(workspace)
  if (planAction(q) === 'use' && (await tcpUp(q.lock.port))) {
    const token = await readToken(workspace)
    if (token) {
      lastKnown = { port: q.lock.port, token }
      return lastKnown
    }
    logPlugin('daemon up but workspace token unreadable')
    return null
  }
  logPlugin('daemon did not come up within ' + START_TIMEOUT_MS + 'ms')
  return null
}

// Serialize ensure attempts so setup and a self-heal triggered while
// setup is still polling cannot spawn two daemons.
let inFlight = null
function ensureDaemon(daemonHome, workspace) {
  if (inFlight) return inFlight
  inFlight = doEnsure(daemonHome, workspace).finally(() => {
    inFlight = null
  })
  return inFlight
}

// --- plugin -----------------------------------------------------------

export default {
  id: 'relay-autostart',
  async setup(ctx) {
    // 0030: this instance's checkout, captured at setup - the source
    // is deterministic (config discovery), unlike a per-tool-call
    // lookup that races project switches.
    const project = String(ctx.location?.directory ?? '')
    logPlugin('setup: probing relay daemon (project ' + project + ')')
    const info = await ensureDaemon(DAEMON_HOME, WORKSPACE)
    if (!info) {
      logPlugin(
        'daemon unavailable; NOT registering the relay MCP server ' +
          '(registering a dead server caches a failed connection)')
    }
    const mcpReg = await ctx.mcp.transform((editor) => {
      if (!lastKnown) return
      editor.set(SERVER_NAME, relayServerConfig(lastKnown, project))
    })
    let lastHealAt = 0
    const toolReg = await ctx.tool.hook('execute.after', async (event) => {
      if (event.status !== 'error') return
      const name = String(event.tool ?? event.id ?? '')
      if (!isRelayTool(name)) return
      const now = Date.now()
      if (now - lastHealAt < HEAL_MIN_INTERVAL_MS) return
      lastHealAt = now
      logPlugin('relay tool error (' + name + '); healing')
      const healed = await ensureDaemon(DAEMON_HOME, WORKSPACE)
      if (healed) {
        await ctx.mcp.reload()
        logPlugin('daemon back on port ' + healed.port + '; mcp reloaded')
      } else {
        logPlugin('respawn failed; agent-side retry guidance (0019) is the fallback')
      }
    })
    if (info) {
      logPlugin('relay registered on port ' + info.port)
    }
    return () => {
      void mcpReg.dispose()
      void toolReg.dispose()
    }
  },
}
