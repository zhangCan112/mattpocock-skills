// auto-handoff 插件 · TUI 纯逻辑层（tui-core.ts）——2026-11-10 v0.28 接力链轮从 tui.ts
// 拆层：纯函数与结构面归此（零 npm 依赖，node --test 直测），tui.ts 收窄为插件入口与
// 事件接线，chain-panel.tsx 为渐进增强的接力链面板（JSX，由 tui.ts 动态装载）。
// v0.28 前的沿革见 tui.ts 头注（内容不变搬迁，本层不引入新平台面）。
//
// 两半契约（server 半 handoff-core.ts，各持副本勿改单边）：
//   1. title 前缀「接力 @」——自动跟随的导航判据（v0.27 起）；
//   2. metadata 键 "relay.parent" —— 接力会话记住原会话 id，链重建的数据源（v0.28 起）。

export const RELAY_TITLE_PREFIX = "接力 @"

/** 接力链 metadata 键（契约第二条的 TUI 半副本，值须与 handoff-core.ts 一致——测试锁） */
export const RELAY_PARENT_META = "relay.parent"

/** TUI 宿主面最小结构（零依赖纪律：不 import SDK 类型；成员可选——运行时逐项探测
 *  降级。Google TS 任意型禁令的落地替代：结构性类型描述宿主面）。 */
export interface TuiHost {
  location?: { directory?: unknown }
  client?: { session?: { list?(): Promise<unknown> } }
  data?: {
    on?(type: string, handler: (event: unknown) => void): () => void
    session?: {
      get?(sessionID: string): RelaySession | undefined
      sync?(sessionID: string): Promise<void>
      list?(): RelaySession[]
    }
  }
  ui?: {
    tabs?: { focus?(sessionID: string): boolean }
    router?: { navigate?(destination: Record<string, unknown>): void }
    toast?: { show?(options: Record<string, unknown>): void }
    panel?: { open?(name: string, options?: { presentation?: string }): boolean }
    slot?(claim: Record<string, unknown>): () => void
  }
  keymap?: { layer?(spec: unknown): void }
}

/** 接力会话最小视图形态（逃生门/跟随/链面板取数面所需字段） */
export interface RelaySession {
  id?: string
  title?: string
  time?: { created?: unknown; updated?: unknown }
}

/** 动态载荷防御视图（与 handoff-core.ts 同款）：非对象视作空记录，字段仍需收窄 */
export function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** 会话是否为接力会话（title 特征判据；导出供测试）。类型谓词：守卫通过即视作
 *  RelaySession 视图，调用方免断言取 id/title。 */
export function isRelaySession(info: unknown): info is RelaySession {
  const title = obj(info).title
  return typeof title === "string" && title.startsWith(RELAY_TITLE_PREFIX)
}

/** 会话时间戳（updated ?? created ?? 0；排序与「最近」判据共用；入参收窄在内部完成） */
export function timeOf(s: unknown): number {
  const time = obj(obj(s).time)
  return Number(time.updated ?? time.created ?? 0)
}

/** 最近的接力会话（按 time.updated ?? time.created 取最新；供逃生门与测试） */
export function latestRelaySession(sessions: readonly unknown[]): RelaySession | undefined {
  const relays = (sessions ?? []).filter(isRelaySession)
  if (!relays.length) return undefined
  return relays.reduce((a, b) => (timeOf(a) >= timeOf(b) ? a : b))
}

/** 跟随会话：tabs.focus 优先（需要时开 tab 并聚焦，tabs 禁用返回 false）→ router.navigate 兜底 */
export function followSession(ctx: TuiHost, sessionID: string): boolean {
  try {
    if (ctx?.ui?.tabs?.focus?.(sessionID) === true) return true
  } catch {
    // tabs 面异常 → 走 router 兜底
  }
  const navigate = ctx?.ui?.router?.navigate
  if (typeof navigate !== "function") return false
  try {
    navigate.call(ctx?.ui?.router, { type: "session", sessionID })
    return true
  } catch {
    return false
  }
}

/** 逃生门用会话清单：client（较新）优先，data store 兜底；两形态（数组/{data}）兼容 */
export async function listSessions(ctx: TuiHost): Promise<RelaySession[]> {
  try {
    const res: unknown = await ctx?.client?.session?.list?.()
    const viaData = obj(res).data
    const list = Array.isArray(res) ? res : Array.isArray(viaData) ? viaData : []
    if (list.length) return list
  } catch {
    // client 面异常 → data store 兜底
  }
  try {
    const list = ctx?.data?.session?.list?.()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 取会话记录：get（本地 store）→ sync+get（向 server 拉取）→ onTimer 延迟重试一次 */
export async function sessionInfo(ctx: TuiHost, sessionID: string, onTimer: (t: ReturnType<typeof setTimeout>) => void): Promise<RelaySession | undefined> {
  try {
    const hit = ctx?.data?.session?.get?.(sessionID)
    if (isRelaySession(hit)) return hit
    await ctx?.data?.session?.sync?.(sessionID)
    const synced = ctx?.data?.session?.get?.(sessionID)
    if (isRelaySession(synced)) return synced
  } catch {
    // data 面异常 → 延迟重试也不做，直接放弃（静默降级）
    return undefined
  }
  // title 尚未就位（创建端极慢路径）：400ms 后最后重试一次
  return new Promise((resolve) => {
    try {
      const timer = setTimeout(() => {
        try {
          resolve(ctx?.data?.session?.get?.(sessionID))
        } catch {
          resolve(undefined)
        }
      }, 400)
      onTimer(timer)
    } catch {
      resolve(undefined)
    }
  })
}

// ---- 接力链（v0.28；数据源 = metadata["relay.parent]，渲染 = chain-panel.tsx） ----

/** 读取会话的接力链父链接（metadata 由 handoff_to 写入；缺失/非串收窄为空串） */
export function relayParentOf(info: unknown): string {
  return str(obj(obj(info).metadata)[RELAY_PARENT_META])
}

/** 接力链行（面板按行渲染：一行一跳，只显示 title——2026-11-10 用户定调「简单文字」） */
export interface RelayChainRow {
  readonly session: RelaySession
  readonly isCurrent: boolean
  readonly hop: number // 1 起：起点（最早祖先或当前）= 1，沿线递增
}

/** 接力链视图：rows 按时间正序（祖先旧→新 → 当前 → 后代创建序）；legacy = 当前是
 *  旧版接力会话（无链数据——v0.28 之前创建，title 特征在但 metadata 未落）。 */
export interface RelayChain {
  readonly rows: readonly RelayChainRow[]
  readonly legacy: boolean
}

/** 走链上限：脏数据/手工构造的环不死循环（面板行数也天然受限） */
export const MAX_CHAIN_HOPS = 100

/** 重建当前会话的完整接力链（纯函数，输入 = 会话清单快照 + 当前会话 id）。
 *  祖先：只从「接力 @」会话起步沿 relay.parent 上溯；普通会话是链的起点（无链接可走），
 *    已删除的祖先在断链处停（不虚构行）。子代理会话虽继承宿主 metadata，但只有
 *    handoff_to 建的会话有「接力 @」title——title 判据把继承噪声滤在链外。
 *  后代：接力 title 且 relay.parent 指向链内节点的会话，创建时间正序、深度优先展开
 *    （同一会话多次接力 = 分叉，各支各成行）。 */
export function relayChain(sessions: readonly unknown[], sessionID: string): RelayChain {
  const byID = new Map<string, Record<string, unknown>>()
  for (const s of sessions ?? []) {
    const rec = obj(s)
    const id = str(rec.id)
    if (id) byID.set(id, rec)
  }
  const current = sessionID ? byID.get(sessionID) : undefined
  if (!current) return { rows: [], legacy: false }

  const seen = new Set<string>([sessionID])
  const ancestors: Record<string, unknown>[] = []
  if (isRelaySession(current)) {
    let node: Record<string, unknown> = current
    for (let step = 0; step < MAX_CHAIN_HOPS; step++) {
      const parentID = relayParentOf(node)
      if (!parentID || seen.has(parentID)) break
      const parent = byID.get(parentID)
      if (!parent) break // 祖先已被删除：链在此断
      ancestors.push(parent)
      seen.add(parentID)
      if (!isRelaySession(parent)) break // 起点是普通会话：到头
      node = parent
    }
  }
  ancestors.reverse() // 旧 → 新

  const descendants: Record<string, unknown>[] = []
  const walk = (id: string, depth: number): void => {
    if (depth > MAX_CHAIN_HOPS) return
    const children = [...byID.values()]
      .filter((s) => isRelaySession(s) && relayParentOf(s) === id && !seen.has(str(s.id)))
      .sort((a, b) => timeOf(a) - timeOf(b) || str(a.id).localeCompare(str(b.id)))
    for (const child of children) {
      const cid = str(child.id)
      if (!cid) continue
      seen.add(cid)
      descendants.push(child)
      walk(cid, depth + 1)
    }
  }
  walk(sessionID, 0)

  const line = [...ancestors, current, ...descendants]
  const rows: RelayChainRow[] = line.map((session, i) => ({
    session: recordView(session),
    isCurrent: i === ancestors.length,
    hop: i + 1,
  }))
  const legacy =
    isRelaySession(current) && ancestors.length === 0 && descendants.length === 0 && !relayParentOf(current)
  return { rows, legacy }
}

/** 原始记录 → RelaySession 视图（字段显式收窄，免断言） */
function recordView(rec: Record<string, unknown>): RelaySession {
  const time = obj(rec.time)
  const id = str(rec.id)
  return {
    ...(id ? { id } : {}),
    title: str(rec.title) || undefined,
    time: { created: time.created, updated: time.updated },
  }
}
