// skill-trail 持久层状态机(store.ts)——2026-11-04 治理轮从 index.ts setup 闭包深化搬迁:
// LRU 逐出 / 按会话串行落盘 / 增量落账闸(createDeltaLedger,明细 durable 才计数)/ 累计层
// 读-改-写 / 扫频限流 / 冷会话水合 / 触发情境回填 / 启动清理,全部收进 TrailStore 一个 seam。
// storage 与会话转录经 TrailStoreIO 注入(node --test 直测,compaction.ts 的 Watcher 同款
// 分层纪律);纯函数(apply*/merge/reconcile/diff/aggregate)仍在 trail.ts,由接线层组合后
// 喂入。搬迁不改行为——语义出处与平台实证见 index.ts 头注,域词见 GLOSSARY.md。
import {
  applyTotalsDelta,
  capTotals,
  collectFromTranscript,
  createDeltaLedger,
  diffTotalsDelta,
  extractTriggerContext,
  mergeRecords,
  obj,
  reconcileTranscript,
  sanitizeTotals,
  type SkillRecord,
  type TotalsMap,
} from "./trail.ts"

/** 逻辑层宿主面(结构性最小面,Google TS:任意型零手写):接线层从 SDK Plugin.Context
 *  装配真 adapter,测试传内存 fake——两个 adapter 坐实 seam。storage 域方法返回值一律
 *  unknown(动态载荷曾偏离 .d.ts 形态,实证),store 内部经 obj/Array.isArray 收窄。
 *  set 的 value 只会出现明细层记录数组与累计层计数两种形状(type alias 隐式索引签名
 *  过 SDK storage.set 的 Json 边界,见 trail.ts SkillRecord 注)。 */
export interface TrailStoreIO {
  get(key: string): Promise<unknown>
  set(key: string, value: SkillRecord[] | TotalsMap): Promise<void>
  scan(query: { prefix: string; limit: number; after?: string }): Promise<unknown>
  remove(key: string): Promise<void>
  /** 拉会话转录(sweep 对账 / enrich 情境回填用);返回值按不可信载荷收窄 */
  sessionContext(sessionID: string): Promise<unknown>
  probe(entry: Record<string, unknown>): void
  now(): number
}

/** 限额与窗口(缺省 = 生产常量;测试可缩,免造 33 会话/真等 60 秒) */
export interface TrailStoreLimits {
  recordsPerSession: number // 单会话保留记录数上限(TUI 展示截尾 8 条,留审计余量)
  sessionsInMemory: number // 内存跟踪会话数上限(LRU,防 server 生命周期内无限增长)
  sessionsInStorage: number // 明细层保留会话数上限(启动清理超出部分,保新删旧)
  sweepMinIntervalMs: number // 同会话扫频下限(回合事件密集/重放时限流)
  enrichWindowMs: number // 触发情境回填的目标记录定位窗口
}

const DEFAULT_LIMITS: TrailStoreLimits = {
  recordsPerSession: 64,
  sessionsInMemory: 32,
  sessionsInStorage: 64,
  sweepMinIntervalMs: 60_000,
  enrichWindowMs: 15_000,
}

const STORAGE_PREFIX = "trail:"
const TOTALS_KEY = "stats:totals" // 独立前缀:不参与明细层清理
const LAST_SWEPT_TABLE_MAX = 128 // 限流表防膨胀:只需近窗口条目,过期的整体丢弃

function storageKey(sid: string): string {
  return `${STORAGE_PREFIX}${sid}`
}

function latestTs(records: SkillRecord[]): number {
  let latest = 0
  for (const r of records ?? []) {
    if (typeof r?.ts === "number" && r.ts > latest) latest = r.ts
  }
  return latest
}

/** 足迹双层的持有者(见 GLOSSARY.md「TrailStore」):收新记录,保明细层与累计层的
 *  存储一致。全部状态 #private,方法即 interface;构造后须在注册采集面前 await init()。 */
export class TrailStore {
  readonly #io: TrailStoreIO
  readonly #limits: TrailStoreLimits
  #bySession = new Map<string, SkillRecord[]>() // 插入序即 LRU 序(touch 时 delete+set 刷新热度)
  #hydrating = new Set<string>() // 水合中的会话(防并发重复拉取)
  #persistChain = new Map<string, Promise<void>>() // 按会话串行化 storage 写入
  #sweeping = new Set<string>() // 扫描中的会话(防并发重复扫)
  #lastSwept = new Map<string, number>() // 最近扫描时刻(扫频限流)
  #sweepChain: Promise<void> = Promise.resolve() // 全局串行扫描链(重放风暴下 IO 温和)
  #totals: TotalsMap = {} // 累计层内存态(本 location 实例视角;报告以 storage 新鲜态为准)
  #pendingDeltas: TotalsMap[] = [] // 已 durable 未落账增量(写失败/写前入队的都留在这,成功才出队)
  #totalsFlushChain: Promise<void> = Promise.resolve() // 累计层落账串行链
  #ledger = createDeltaLedger() // 增量落账闸:明细持久化成功(settle)才入 #pendingDeltas

  constructor(io: TrailStoreIO, limits?: Partial<TrailStoreLimits>) {
    this.#io = io
    this.#limits = { ...DEFAULT_LIMITS, ...limits }
  }

  /** 累计层恢复(失败从零开始,明细层照常工作)+ 装载自证探针(fire-and-forget)。
   *  接线层在注册采集 hook 前 await——时序保证:账已恢复才采信后续差分。 */
  async init(): Promise<void> {
    try {
      this.#totals = sanitizeTotals(await this.#io.get(TOTALS_KEY))
    } catch {
      // 恢复失败静默
    }
    // 装载自证 + storage 前缀自检(探针首查线):下次「看着失效」可一眼分辨
    // 「没触发 / 采集断 / 命名空间漂移」——storageSessions=0 而 transcript 明明有
    // skill 调用 → 优先怀疑插件改名后的旧 id 命名空间漂移(写入别处,本前缀读不到)。
    void (async () => {
      try {
        const { sessions } = await this.scanTrail()
        this.#io.probe({ hook: "setup.done", storageSessions: sessions.length, totalsSkills: Object.keys(this.#totals).length })
      } catch {
        // 静默:探针面绝不反噬装载
      }
    })()
  }

  /** 会话当前记录(内存态;喂 apply* 组合下一版快照用) */
  recordsOf(sid: string): SkillRecord[] {
    return this.#bySession.get(sid) ?? []
  }

  /** 记录统一入口:差分出本事件增量 → 落账闸扣留(持久化成功才计数)→ 截尾 +
   *  LRU → 落盘;内存未跟踪的会话(冷启动/被逐出)事后水合。 */
  commit(sid: string, records: SkillRecord[]): void {
    const known = this.#bySession.has(sid)
    const prev = this.recordsOf(sid)
    const delta = diffTotalsDelta(prev, records)
    if (delta) this.#ledger.hold(sid, delta)
    this.#touch(sid, records)
    this.#queuePersist(sid)
    if (!known) this.#hydrate(sid)
  }

  /** 异步取会话消息,摘录激活前最近一条用户消息回填 prompt(await 后重定位防竞态) */
  enrich(sid: string, skillID: string, ts: number): void {
    void (async () => {
      try {
        if (this.#findEnrichTarget(sid, skillID, ts) === undefined) return
        // 形态兼容:数组 / {data}(实证 2026-11 v2.2.5 为 {data} 包装)——返回值按 unknown 收窄
        const res: unknown = await this.#io.sessionContext(sid)
        const wrapped = obj(res).data
        const messages = Array.isArray(res) ? res : Array.isArray(wrapped) ? wrapped : undefined
        if (messages === undefined) {
          this.#io.probe({
            hook: "enrich.context.unrecognized",
            type: res === null ? "null" : typeof res,
            keys: res && typeof res === "object" ? Object.keys(res).slice(0, 12) : [],
          })
          return
        }
        const snippet = extractTriggerContext(messages, ts)
        if (!snippet) {
          this.#io.probe({ hook: "enrich.no-snippet", sessionID: sid, skillID }) // 有记录但没摘到用户消息
          return
        }
        const idx = this.#findEnrichTarget(sid, skillID, ts)
        if (idx === undefined) return
        const records = this.#bySession.get(sid) ?? []
        this.#touch(sid, records.map((r, i) => (i === idx ? { ...r, prompt: snippet } : r)))
        this.#queuePersist(sid)
      } catch {
        // 情境摘录失败静默(记录本身不受影响)
      }
    })()
  }

  /** 回合结束扫 transcript × 事件账对账(用户 @mention 补盲主路)。
   *  冷会话先取 storage 历史做基线——transcript 里的旧激活大多已被事件路计过数,
   *  空基线对账会把它们当新增 → 累计层双计;取回的动作只 touch(恢复已计过数的
   *  记录)不走 commit 差分,与 hydrate 同语义。全局串行 + 同会话在飞去重 + 扫频
   *  限流;对账幂等(reconcileTranscript 精确键 + 窗口认领),durable 事件重放无害。 */
  sweep(sid: string, reason: string): void {
    if (this.#sweeping.has(sid)) return
    const now = this.#io.now()
    const last = this.#lastSwept.get(sid)
    if (last !== undefined && now - last < this.#limits.sweepMinIntervalMs) return
    if (this.#lastSwept.size > LAST_SWEPT_TABLE_MAX) {
      for (const [k, v] of this.#lastSwept) if (now - v >= this.#limits.sweepMinIntervalMs) this.#lastSwept.delete(k)
    }
    this.#sweeping.add(sid)
    this.#lastSwept.set(sid, now)
    this.#sweepChain = this.#sweepChain.catch(() => {}).then(async () => {
      try {
        if (!this.#bySession.has(sid)) {
          // 宿主边界读点:storage 数组载荷与 SkillRecord 形态一致(hydrate 同款单点视)
          const stored: unknown = await this.#io.get(storageKey(sid))
          if (Array.isArray(stored)) this.#touch(sid, mergeRecords(stored as SkillRecord[], this.recordsOf(sid)))
        }
        const res: unknown = await this.#io.sessionContext(sid)
        const wrapped = obj(res).data
        const messages = Array.isArray(res) ? res : Array.isArray(wrapped) ? wrapped : undefined
        if (messages === undefined) {
          this.#io.probe({ hook: "sweep.context.unrecognized", sessionID: sid, type: res === null ? "null" : typeof res })
          return
        }
        const prev = this.recordsOf(sid)
        const next = reconcileTranscript(prev, collectFromTranscript(messages))
        if (JSON.stringify(next) === JSON.stringify([...prev].sort((a, b) => a.ts - b.ts))) return // 无变化零写入
        this.commit(sid, next)
        this.#io.probe({ hook: "sweep.committed", sessionID: sid, reason, prev: prev.length, next: next.length })
      } catch {
        // 扫描失败静默(下回合事件再触发)
      } finally {
        this.#sweeping.delete(sid)
      }
    })
  }

  /** 扫描明细层:有效会话 + 畸形条目 key(prune 删除用;报告只用前者) */
  async scanTrail(): Promise<{
    sessions: Array<{ sid: string; records: SkillRecord[]; latest: number }>
    malformedKeys: string[]
  }> {
    const sessions: Array<{ sid: string; records: SkillRecord[]; latest: number }> = []
    const malformedKeys: string[] = []
    try {
      let after: string | undefined
      do {
        // 域方法返回值按不可信载荷处理(实证曾偏离 .d.ts 形态)→ unknown 收窄
        const page: unknown = await this.#io.scan({ prefix: STORAGE_PREFIX, limit: 100, after })
        const entries = obj(page).entries
        if (!Array.isArray(entries) || entries.length === 0) break
        for (const e of entries) {
          const rawKey = obj(e).key
          const key = typeof rawKey === "string" ? rawKey : ""
          if (!key.startsWith(STORAGE_PREFIX)) continue
          const sid = key.slice(STORAGE_PREFIX.length)
          if (!sid) continue
          const value = obj(e).value
          if (!Array.isArray(value)) {
            malformedKeys.push(key)
            continue
          }
          sessions.push({ sid, records: value, latest: latestTs(value) })
        }
        const next = obj(page).next
        after = typeof next === "string" ? next : undefined
      } while (after)
    } catch {
      // 扫描失败:返回已得部分
    }
    return { sessions, malformedKeys }
  }

  /** 累计层取数:storage 新鲜态 + 本实例已 durable 未落账增量(多 location 实例并存时,
   *  本实例内存态可能落后于别处已落账的计数——以 storage 为准);读失败退内存态。
   *  读时 heal(healTotals,强制 lifetime ≥ 窗口的单向对账)由报告调用方组合。 */
  async reportTotals(): Promise<TotalsMap> {
    try {
      const stored = sanitizeTotals(await this.#io.get(TOTALS_KEY))
      return this.#pendingDeltas.reduce((acc, d) => applyTotalsDelta(acc, d), stored)
    } catch {
      return this.#totals // 读失败退内存态
    }
  }

  /** 启动清理:删畸形条目(非数组);会话数超限删最旧;单会话历史超限截尾(仅超限时回写,避免写放大) */
  async prune(): Promise<void> {
    try {
      const { sessions, malformedKeys } = await this.scanTrail()
      for (const key of malformedKeys) {
        try {
          await this.#io.remove(key)
        } catch {
          // 删除失败跳过(下次启动再试)
        }
      }
      sessions.sort((a, b) => b.latest - a.latest)
      for (const s of sessions.slice(this.#limits.sessionsInStorage)) {
        try {
          await this.#io.remove(storageKey(s.sid))
        } catch {
          // 删除失败跳过
        }
      }
      for (const s of sessions.slice(0, this.#limits.sessionsInStorage)) {
        if (s.records.length > this.#limits.recordsPerSession) {
          try {
            await this.#io.set(storageKey(s.sid), s.records.slice(-this.#limits.recordsPerSession))
          } catch {
            // 回写失败跳过(下次启动再试)
          }
        }
      }
    } catch {
      // 清理失败静默(不影响装载与采集)
    }
  }

  /** 截尾入表 + 刷新 LRU 热度 + 逐出最旧会话(绝不逐出当前会话) */
  #touch(sid: string, records: SkillRecord[]): void {
    const capped = records.slice(-this.#limits.recordsPerSession)
    this.#bySession.delete(sid)
    this.#bySession.set(sid, capped)
    while (this.#bySession.size > this.#limits.sessionsInMemory) {
      const oldest = this.#bySession.keys().next().value
      if (oldest === undefined || oldest === sid) break
      this.#bySession.delete(oldest)
    }
  }

  /** 水合:内存未跟踪的会话先增量落盘(commit 已做),再取回 storage 历史与内存增量合并。
   *  await 之后是同步块(单线程原子),与水合期间新到的事件无竞态。
   *  不走 commit:mergeRecords 恢复的是已计过数的旧记录,差分累计会重复。 */
  #hydrate(sid: string): void {
    if (this.#hydrating.has(sid)) return
    this.#hydrating.add(sid)
    void (async () => {
      try {
        const stored = await this.#io.get(storageKey(sid))
        if (Array.isArray(stored)) {
          // 宿主边界读点:storage 数组载荷与 SkillRecord 形态一致(sweep 冷基线同款单点视)
          this.#touch(sid, mergeRecords(stored as SkillRecord[], this.recordsOf(sid)))
          this.#queuePersist(sid)
        }
      } catch {
        // 水合失败:以内存增量为准(已由 commit 落盘)
      } finally {
        this.#hydrating.delete(sid)
      }
    })()
  }

  /** 明细已 durable → 释放该会话被扣留的累计增量(先计内存态再入 flush 队列)。
   *  持久化写的是执行时最新快照(superset),一次成功即可全量释放。 */
  #releaseHeld(sid: string): void {
    const released = this.#ledger.settle(sid)
    if (!released) return
    this.#totals = capTotals(applyTotalsDelta(this.#totals, released))
    this.#pendingDeltas.push(released)
    this.#queueTotalsFlush()
  }

  /** 串行化 per-session 写入;执行时读最新快照(记录 append-only + 截尾,
   *  后写快照必是前写超集),即便队列乱序完成也不会回退 storage 内容。
   *  写成功即释放该会话扣留中的累计增量(落账闸,见 createDeltaLedger 头注);
   *  写失败保持扣留——计数随内存与明细同殒,重启后 sweep 重扫恰计一次。 */
  #queuePersist(sid: string): void {
    const prev = this.#persistChain.get(sid) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        await this.#io.set(storageKey(sid), this.recordsOf(sid))
        this.#releaseHeld(sid)
      } catch {
        // 存储失败静默降级(内存态仍在;扣留的增量待下次持久化成功释放)
      }
    })
    this.#persistChain.set(sid, next)
    void next.then(() => {
      if (this.#persistChain.get(sid) === next) this.#persistChain.delete(sid)
    })
  }

  /** 累计层落账(串行):读 storage 最新态 → 折叠未落账 delta 重放叠加 → 写回 → 成功才出队。
   *  读-改-写让跨 location 的插件实例不互覆(每个实例只写自己的增量,窗口极小的同 skill
   *  并发仍可能丢一次,接受并文档化);读/写失败 delta 留队,下次事件触发自动重试。 */
  #queueTotalsFlush(): void {
    this.#totalsFlushChain = this.#totalsFlushChain.catch(() => {}).then(async () => {
      try {
        while (this.#pendingDeltas.length > 0) {
          const len = this.#pendingDeltas.length
          const folded = this.#pendingDeltas.slice(0, len).reduce((acc, d) => applyTotalsDelta(acc, d), {} as TotalsMap)
          let base: TotalsMap
          try {
            base = sanitizeTotals(await this.#io.get(TOTALS_KEY))
          } catch {
            this.#io.probe({ hook: "totals.flush.read-failed", pending: len })
            return // 读失败整批留队(下次事件重试),不做盲写覆盖
          }
          await this.#io.set(TOTALS_KEY, capTotals(applyTotalsDelta(base, folded)))
          this.#pendingDeltas.splice(0, len) // 成功才出队;写期间新入队的下一轮循环处理
        }
      } catch {
        this.#io.probe({ hook: "totals.flush.failed", pending: this.#pendingDeltas.length })
      }
    })
  }

  /** 触发情境回填目标:同 skill、未带 prompt、ts∈[t-窗口, t] 的最近一条记录下标 */
  #findEnrichTarget(sid: string, skillID: string, ts: number): number | undefined {
    const records = this.#bySession.get(sid)
    if (!records) return undefined
    let best: number | undefined
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!
      if (r.skillID !== skillID || r.prompt) continue
      if (r.ts <= ts && ts - r.ts <= this.#limits.enrichWindowMs) {
        if (best === undefined || records[best]!.ts < r.ts) best = i
      }
    }
    return best
  }
}
