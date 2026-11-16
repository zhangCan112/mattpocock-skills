// skill-trail 纯逻辑层 —— skill 调用记录的采集/合并/格式化（无平台依赖，node --test 直测）
// 数据面四路信号（实证）：
//   ① tool.execute.before/after（tool==="skill"，入参 {id}）——主信号，带 agent 归属
//   ② session.skill.activated 事件（data:{sessionID,id,name,text}）——仅 @deprecated 的
//      session.skill 显式装载 API 发射（2026-11-03 二进制定界）；2.2.5 桌面流程
//      （@mention 内联进 prompt 载荷）与 skill 工具调用路均不发射——留作 SDK 路兜底
//   ③ transcript——持久回填源，双形态（冒烟实证）：type:"skill" 专型消息
//      （{skill,name,text,time.created}，显式加载路径）+ assistant 消息的
//      {type:"tool",name:"skill"} 部件（state.input.id/metadata.name/status，模型路径）；
//      用户 part 的 skills[].mention = 显式 @mention 标记（触发情境判别依据）
//   ④ 回合结束事件 → transcript 现算 × 事件账对账（reconcileTranscript）——server 持久层
//      对用户 @mention 的补盲路（②死路后用户手动触发的唯一入账途径）
// 触发情境推断：skill 工具调用 = 模型自动；activated 无对应工具调用 = 用户显式
// （@mention / 命令入口，不经工具管线）；transcript 侧以用户 part mention 标记对账
// （回合内一次性消费，跨回合各自成账——见 mentionMap 头注）。

export type Trigger = "user" | "model" | "unknown"

// type alias（非 interface）：SDK storage.set 的 Json 形要求索引签名，类型别名可得的
// 隐式索引签名正好过界（interface 不行）——这是存储边界，改动前先看 set 调用点
export type SkillRecord = {
  ts: number // epoch ms
  skillID: string
  name?: string
  agent?: string // 触发者 Agent.ID（仅工具调用路径可得）
  trigger: Trigger
  status?: "completed" | "error"
  callID?: string // 工具调用幂等键（execute.after 回填 status 用）
  prompt?: string // 触发情境摘录（激活前最近一条用户消息，≤120 字符；用户路径=@mention 原文，模型路径=引发选用的当前轮请求）
}

// ---------- transcript 回填（TUI 视图主数据源） ----------

/** 收集用户消息里被 @mention 的 skill（parts[].skills[].id，防御式多层形态容忍）。
 *  每条 mention 带回合上界 ceiling = 下一条用户消息时刻（末条 = ∞）：mention 只能被
 *  本回合内的激活消费——跨回合不回溯消费，保证 transcript 视图单调（对账收敛前提，
 *  见 trail.test.ts「mention 回合边界」节）。 */
function mentionMap(messages: readonly unknown[]): Map<string, Array<{ ts: number; name?: string; ceiling: number }>> {
  const userTs: number[] = []
  for (const m of messages ?? []) {
    const mv = obj(m)
    if (mv.type !== "user") continue
    const t = num(obj(mv.time).created)
    if (t > 0) userTs.push(t)
  }
  userTs.sort((a, b) => a - b)
  const ceilingOf = (at: number): number => {
    const i = userTs.findIndex((u) => u > at)
    return i < 0 ? Number.POSITIVE_INFINITY : userTs[i]!
  }
  const out = new Map<string, Array<{ ts: number; name?: string; ceiling: number }>>()
  for (const m of messages ?? []) {
    const mv = obj(m)
    if (mv.type !== "user") continue
    const ts = num(obj(mv.time).created)
    const rawParts = mv.parts
    const rawContent = mv.content
    const partList = Array.isArray(rawParts) ? rawParts : Array.isArray(rawContent) ? rawContent : []
    const candidates = [...partList.map((p) => obj(p).skills), mv.skills]
    for (const arr of candidates) {
      if (!Array.isArray(arr)) continue
      for (const s of arr) {
        const id = str(obj(s).id)
        if (!id) continue
        const list = out.get(id) ?? []
        if (ts > 0) list.push({ ts, name: str(obj(s).name) || undefined, ceiling: ceilingOf(ts) })
        out.set(id, list)
      }
    }
  }
  for (const [, list] of out) list.sort((a, b) => a.ts - b.ts)
  return out
}

/** 取走 skillID 最早一条不晚于 at 且仍在本回合内（at < ceiling）的 mention
 *  （一次性消费：一次 mention 对应一次激活；跨回合的不消费） */
function consumeMention(
  mentions: Map<string, Array<{ ts: number; name?: string; ceiling: number }>>,
  skillID: string,
  at: number,
): { ts: number; name?: string } | undefined {
  const list = mentions.get(skillID)
  if (!list || list.length === 0) return undefined
  const i = list.findIndex((e) => e.ts <= at && at < e.ceiling)
  if (i < 0) return undefined
  return list.splice(i, 1)[0]
}

/**
 * transcript → 该会话的 skill 激活时间线（按 ts 升序）。
 * 三路径（2.2.5 双次真形取证）：
 *   - 模型自动调用 = assistant 消息的 {type:"tool", name:"skill"} 部件
 *     （state.input.id / state.metadata.name / state.status，agent 在消息级）；
 *   - 显式加载（旧形态）= type:"skill" 专型消息（含注入正文）；
 *   - 显式加载（2.2.5 形态）= 用户 @mention 内联进用户消息 skills[]
 *     （带 mention 偏移对象；host 对该流程不发射 session.skill.activated，
 *     也不追加专型消息——未消费的 mention 自身即一次 user 激活，兜底成账）。
 * 触发判别：同 id 激活前、且同回合内（mention 与激活之间无新用户消息）存在未消费
 * mention（一次性消费）→ "user"；跨回合的 mention 不回溯消费（transcript 视图单调，
 * 对账收敛前提）。
 * 同 id 窗口内去重（专型消息优先，保留其 name）。
 */
export function collectFromTranscript(messages: readonly unknown[]): SkillRecord[] {
  const mentions = mentionMap(messages)
  const records: SkillRecord[] = []
  const toolSeen: Array<{ skillID: string; ts: number }> = []
  for (const m of messages ?? []) {
    const mv = obj(m)
    if (mv.type !== "skill") continue
    const skillID = str(mv.skill)
    if (!skillID) continue
    const ts = num(obj(mv.time).created)
    const rec: SkillRecord = { ts, skillID, name: str(mv.name) || undefined, trigger: "model" }
    if (consumeMention(mentions, skillID, ts)) rec.trigger = "user"
    records.push(rec)
    toolSeen.push({ skillID, ts })
  }
  // 模型工具调用路径：assistant 消息的 skill 工具部件
  for (const m of messages ?? []) {
    const mv = obj(m)
    const rawParts = mv.parts
    const rawContent = mv.content
    const partList = Array.isArray(rawParts) ? rawParts : Array.isArray(rawContent) ? rawContent : []
    for (const p of partList) {
      const pv = obj(p)
      if (pv.type !== "tool" || str(pv.name ?? pv.tool) !== "skill") continue
      const state = obj(pv.state)
      const skillID = str(obj(state.input).id)
      if (!skillID) continue
      const ts = num(obj(pv.time).created) || num(obj(mv.time).created)
      // 与专型消息同 id 窗口内去重（专型消息已记录该次激活）
      if (toolSeen.some((s) => s.skillID === skillID && Math.abs(s.ts - ts) <= 15_000)) continue
      // 用户点名后模型随即调用 = user 触发（mention 一次性消费，不双计）
      const mention = consumeMention(mentions, skillID, ts)
      const status = state.status
      records.push({
        ts,
        skillID,
        name: str(obj(state.metadata).name) || mention?.name || undefined,
        agent: str(mv.agent) || undefined,
        trigger: mention ? "user" : "model",
        status: status === "error" ? "error" : status === "completed" ? "completed" : undefined,
      })
    }
  }
  // 2.2.5 兜底:未被任何激活消费的 mention 自身成账（同 id 同刻只记一条,防重复 mention 条目）
  for (const [skillID, list] of mentions) {
    for (const entry of list) {
      if (records.some((r) => r.skillID === skillID && r.ts === entry.ts && r.trigger === "user")) continue
      records.push({ ts: entry.ts, skillID, name: entry.name || undefined, trigger: "user" })
    }
  }
  // 触发情境回填：同一份 transcript 摘录每条记录激活前最近的用户消息
  // （与 server 采集侧 enrichPrompt 同语义、独立数据源，互不依赖）
  for (const rec of records) {
    const snippet = extractTriggerContext(messages, rec.ts)
    if (snippet) rec.prompt = snippet
  }
  return records.sort((a, b) => a.ts - b.ts)
}

// ---------- server 采集（index.ts 部件用；纯函数 + 注入时间，幂等可测） ----------

const MERGE_WINDOW_MS = 10_000

/** tool.execute.before（tool==="skill"）→ 追加模型调用记录 */
export function applyToolBefore(
  records: SkillRecord[],
  ev: { callID?: string; skillID: string; agent?: string; ts: number },
): SkillRecord[] {
  if (!ev?.skillID) return records
  if (ev.callID && records.some((r) => r.callID === ev.callID)) return records // 幂等
  return [...records, {
    ts: ev.ts,
    skillID: ev.skillID,
    agent: ev.agent || undefined,
    trigger: "model",
    callID: ev.callID,
  }]
}

/** tool.execute.after → 按 callID 回填 status */
export function applyToolAfter(
  records: SkillRecord[],
  ev: { callID?: string; skillID: string; status: "completed" | "error"; ts: number },
): SkillRecord[] {
  if (!ev?.skillID) return records
  let hit = false
  const out = records.map((r) => {
    const match = (ev.callID && r.callID === ev.callID) ||
      (!ev.callID && r.skillID === ev.skillID && !r.status &&
        Math.abs(r.ts - ev.ts) <= MERGE_WINDOW_MS)
    if (!match) return r
    hit = true
    return { ...r, status: ev.status }
  })
  return hit ? out : records
}

/**
 * session.skill.activated → 合并或追加。
 * 窗口内存在同 id 无名工具记录 → 补 name（模型调用路径）；
 * 否则追加 "user" 记录（activated 无工具调用伴随 = 显式加载路径）。
 */
export function applyActivated(
  records: SkillRecord[],
  ev: { skillID: string; name?: string; ts: number },
): SkillRecord[] {
  if (!ev?.skillID) return records
  let hit = false
  const out = records.map((r) => {
    if (hit || r.skillID !== ev.skillID || r.name || !r.callID ||
      Math.abs(r.ts - ev.ts) > MERGE_WINDOW_MS) return r
    hit = true
    return { ...r, name: ev.name || r.name }
  })
  if (hit) return out
  // 幂等：同 id 同 ts 已有非工具记录则不重复追加
  if (records.some((r) => r.skillID === ev.skillID && !r.callID && r.ts === ev.ts)) return records
  return [...records, { ts: ev.ts, skillID: ev.skillID, name: ev.name || undefined, trigger: "user" }]
}

// ---------- transcript 对账（server 持久层补盲：事件账 × transcript 账） ----------

/**
 * 事件采集账 × transcript 采集账 → 合并时间线（ts 升序）。
 * 背景：host 对用户 @mention 不发射事件（见 trail.test.ts 对账节头注），server 持久层
 * 由「回合结束扫 transcript」补盲——本函数把两侧账目合成一份不双计的账：
 *   - 精确键去重（recordKey 同基）：重扫幂等；
 *   - 窗口匹配：transcript 工具记录 ↔ 事件账里带 callID 的记录（同 skillID ±10s）视为
 *     同一次激活——事件侧胜（保 callID/agent/ts 稳定），transcript 侧补缺（name/prompt/
 *     status 填空），trigger 以 transcript 为准可翻转 model→user（用户 @mention 后模型
 *     调用的场景，与 TUI 侧栏 collectFromTranscript 口径一致，永不反向降级）；
 *   - 未匹配的 transcript 记录（纯 @mention 兜底等）原样入库——本函数的存在意义；
 *   - 事件孤儿保留：transcript 已无对应（如 revert 撤回）的事件记录不清账（现状语义）。
 */
export function reconcileTranscript(
  records: readonly SkillRecord[],
  transcript: readonly SkillRecord[],
): SkillRecord[] {
  const out: SkillRecord[] = [...records]
  const seen = new Set(out.map(recordKey))
  const claimed = new Set<number>() // 已被 transcript 认领的事件记录下标（防一配多）
  for (const t of transcript ?? []) {
    if (!t?.skillID) continue
    if (seen.has(recordKey(t))) continue
    // 窗口匹配：同 skillID ±MERGE_WINDOW_MS 且带 callID 的未认领事件记录 = 同一次激活；
    // 事件侧胜（callID/agent/ts 稳定），transcript 补缺 + trigger 可升格为 user（不降级）
    let hit = -1
    for (let i = 0; i < out.length; i++) {
      const r = out[i]!
      if (claimed.has(i) || !r.callID || r.skillID !== t.skillID) continue
      if (Math.abs(r.ts - t.ts) > MERGE_WINDOW_MS) continue
      hit = i
      break
    }
    if (hit >= 0) {
      claimed.add(hit)
      const r = out[hit]!
      out[hit] = {
        ...r,
        trigger: t.trigger === "user" ? "user" : r.trigger,
        name: r.name || t.name,
        prompt: r.prompt || t.prompt,
        status: r.status || t.status,
        agent: r.agent || t.agent,
      }
      continue
    }
    out.push(t)
    seen.add(recordKey(t))
  }
  return out.sort((a, b) => a.ts - b.ts)
}

// ---------- 水合合并（server 部件：storage 历史 × 内存增量，防逐出后回写丢史） ----------

/**
 * 合并两份记录为一条去重时间线（a = storage 旧史，b = 内存增量）：
 * 有 callID 记录按 callID 去重，保留信息更全的一份（status/name/agent 齐者胜，
 * 同分取 b —— 迭代序靠后者更新鲜）；无 callID 记录按 skillID+ts+trigger 精确去重。
 * 结果按 ts 升序。与 applyActivated 的 (skillID, ts) 幂等键同基，不引入新语义。
 */
export function mergeRecords(a: SkillRecord[], b: SkillRecord[]): SkillRecord[] {
  const byKey = new Map<string, SkillRecord>()
  const score = (r: SkillRecord) => (r.status ? 2 : 0) + (r.name ? 1 : 0) + (r.agent ? 1 : 0) + (r.prompt ? 1 : 0)
  for (const rec of [...a ?? [], ...b ?? []]) {
    if (!rec?.skillID) continue
    const key = recordKey(rec)
    const prev = byKey.get(key)
    byKey.set(key, prev && score(prev) > score(rec) ? prev : rec)
  }
  return [...byKey.values()].sort((x, y) => x.ts - y.ts)
}

/** 记录幂等键：callID 优先，否则 skillID+ts+trigger 精确键（与 applyActivated 幂等键同基） */
function recordKey(rec: SkillRecord): string {
  return rec.callID ? `c:${rec.callID}` : `e:${rec.skillID}@${rec.ts}:${rec.trigger}`
}

// ---------- 触发情境摘录（server 采集侧增强） ----------

export const PROMPT_SNIPPET_MAX = 120

/** ts 之前最近一条用户消息的文本摘录（压平空白，≤120 字符）。
 *  用户路径 = @mention/命令入口原文；模型路径 = 引发模型选用该 skill 的当前轮请求——
 *  这是"什么请求会触发这个 skill"的直接证据，优化 skill 描述时看它。
 *  双形态（实证 2026-11 v2.2.5）：server session.context 用户消息文本在顶层 m.text；
 *  TUI transcript 在 parts[].text。顶层优先，parts 兜底。 */
export function extractTriggerContext(messages: readonly unknown[], ts: number): string | undefined {
  let best: { ts: number; text: string } | undefined
  const partText = (p: unknown): string => {
    const t = obj(p).text
    return typeof t === "string" ? t : ""
  }
  for (const m of messages ?? []) {
    const mv = obj(m)
    if (mv.type !== "user") continue
    const created = num(obj(mv.time).created)
    if (!created || created > ts) continue
    const rawParts = mv.parts
    const rawContent = mv.content
    const partList = Array.isArray(rawParts) ? rawParts : Array.isArray(rawContent) ? rawContent : []
    const top = mv.text
    const raw = typeof top === "string" && top.trim() ? top : partList.map(partText).join(" ")
    const text = raw.replace(/\s+/g, " ").trim()
    if (!text) continue
    if (!best || created >= best.ts) best = { ts: created, text } // 同刻多条取最后一条
  }
  if (!best) return undefined
  return best.text.length > PROMPT_SNIPPET_MAX ? best.text.slice(0, PROMPT_SNIPPET_MAX) + "…" : best.text
}

// ---------- 累计层（跨窗口统计，永不清算——明细层裁剪不影响它） ----------

// type alias（非 interface）：过 storage.set 的 Json 边界，见 SkillRecord 注
export type SkillTotals = {
  total: number
  userTriggers: number
  modelTriggers: number
  errors: number
  firstUsedAt: number
  lastUsedAt: number
}

export type TotalsMap = Record<string, SkillTotals>

/**
 * commit 专用差分：对 apply* 事件的前后快照做差，产出本次事件的**增量**（delta）——
 * 新增记录计次、status 变 error 计错。仅在 commit 路径调用——水合（mergeRecords 恢复
 * 已计过数的旧记录）不走此函数，不重复累计；截尾丢头（slice -64）也不影响：只数新增。
 * 消费方：applyTotalsDelta（内存态/队列用）。空 delta 返回 undefined（零拷贝判空）。
 */
export function diffTotalsDelta(prev: SkillRecord[], next: SkillRecord[]): TotalsMap | undefined {
  let delta: TotalsMap | undefined
  const prevKeys = new Set(prev.map(recordKey))
  const prevStatus = new Map(prev.map((r) => [recordKey(r), r.status]))
  const prevTrigger = new Map(prev.map((r) => [recordKey(r), r.trigger]))
  const add = (skillID: string, d: { total?: number; user?: number; model?: number; errors?: number }, ts: number) => {
    delta ??= {}
    const t = delta[skillID] ?? { total: 0, userTriggers: 0, modelTriggers: 0, errors: 0, firstUsedAt: ts, lastUsedAt: ts }
    delta[skillID] = {
      total: t.total + (d.total ?? 0),
      userTriggers: t.userTriggers + (d.user ?? 0),
      modelTriggers: t.modelTriggers + (d.model ?? 0),
      errors: t.errors + (d.errors ?? 0),
      firstUsedAt: Math.min(t.firstUsedAt, ts),
      lastUsedAt: Math.max(t.lastUsedAt, ts),
    }
  }
  for (const r of next ?? []) {
    if (!r?.skillID) continue
    const key = recordKey(r)
    if (!prevKeys.has(key)) {
      add(r.skillID, {
        total: 1,
        user: r.trigger === "user" ? 1 : 0,
        model: r.trigger === "model" ? 1 : 0,
        errors: r.status === "error" ? 1 : 0,
      }, r.ts)
    } else if (r.status === "error" && prevStatus.get(key) !== "error") {
      add(r.skillID, { errors: 1 }, r.ts)
    } else if (r.trigger === "user" && prevTrigger.get(key) === "model") {
      // 同键归因翻转修正（reconcileTranscript 的 mention 升格,model→user 单向）：
      // user +1 / model −1,总量不变——累计层唯一的非单调字段,原始计数必已存在,
      // 修正后不越零;反向降级不产出（reconcile 永不降级,出现即异常数据,不误修正）
      add(r.skillID, { user: 1, model: -1 }, r.ts)
    }
  }
  return delta
}

/** 计数叠加（纯函数）：base + delta，逐字段相加、时间戳取 min/max。
 *  用途：① 内存态即时累计 ② 未落账 delta 队列折叠 ③ 写前读 storage 最新态重放（跨实例不互覆）。 */
export function applyTotalsDelta(base: TotalsMap, delta: TotalsMap): TotalsMap {
  const out: TotalsMap = { ...base }
  for (const [skillID, d] of Object.entries(delta ?? {})) {
    if (!d || typeof d !== "object") continue
    const t = out[skillID] ?? { total: 0, userTriggers: 0, modelTriggers: 0, errors: 0, firstUsedAt: d.firstUsedAt, lastUsedAt: d.lastUsedAt }
    out[skillID] = {
      total: t.total + (d.total ?? 0),
      userTriggers: t.userTriggers + (d.userTriggers ?? 0),
      modelTriggers: t.modelTriggers + (d.modelTriggers ?? 0),
      errors: t.errors + (d.errors ?? 0),
      firstUsedAt: Math.min(t.firstUsedAt, d.firstUsedAt ?? t.firstUsedAt),
      lastUsedAt: Math.max(t.lastUsedAt, d.lastUsedAt ?? t.lastUsedAt),
    }
  }
  return out
}

/** 累计层兜底上限：防 skillID 病态增长（正常 = skill 数量级，几十）；超限丢最久未用 */
export const MAX_TOTALS_SKILLS = 256

/**
 * 增量落账闸（持久化门控）：delta 先按会话扣留，待该会话的明细层持久化成功
 * （settle）才释放进 flush 队列——把「计数入账」绑定到「明细已 durable」之后。
 * 背景（2026-11-04 报告实证：improve-codebase-architecture 累计 2 vs 窗口 1，
 * first=last 同刻）：明细写失败静默降级而累计照常入账 → 重启后 sweep 以空基线
 * 重扫 transcript → 同一激活再计一次 → 累计双计、窗口因精确键去重仍 1。
 * 门控后明细未持久化 → delta 随内存一起消失，两侧同生同殒，不再分叉。
 * 释放语义：任一次该会话的持久化成功即全量释放——持久化写的是 recordsOf(sid)
 * 执行时最新快照（superset），必然覆盖所有被扣留 delta 背后的记录。
 */
export type DeltaLedger = {
  /** 扣留一版增量（同会话多次扣留折叠为一份，字段相加、时间域 min/max） */
  hold(sid: string, delta: TotalsMap): void
  /** 结算释放该会话全部被扣留增量；无扣留返回 undefined（幂等） */
  settle(sid: string): TotalsMap | undefined
  /** 在押会话数（探针/测试观测） */
  held(): number
}

export function createDeltaLedger(): DeltaLedger {
  const bySid = new Map<string, TotalsMap>()
  return {
    hold(sid, delta) {
      const prev = bySid.get(sid)
      bySid.set(sid, prev ? applyTotalsDelta(prev, delta) : applyTotalsDelta({}, delta))
    },
    settle(sid) {
      const d = bySid.get(sid)
      bySid.delete(sid)
      return d
    },
    held: () => bySid.size,
  }
}


export function capTotals(totals: TotalsMap, max = MAX_TOTALS_SKILLS): TotalsMap {
  const keys = Object.keys(totals)
  if (keys.length <= max) return totals
  const stalest = new Set(
    [...keys].sort((a, b) => (totals[a]!.lastUsedAt ?? 0) - (totals[b]!.lastUsedAt ?? 0)).slice(0, keys.length - max),
  )
  const out: TotalsMap = {}
  for (const k of keys) if (!stalest.has(k)) out[k] = totals[k]!
  return out
}

/** storage 读取防御：剥离畸形条目（非对象/计数缺失的 skill 丢弃）；整体非对象返回空表 */
export function sanitizeTotals(v: unknown): TotalsMap {
  const out: TotalsMap = {}
  if (!v || typeof v !== "object" || Array.isArray(v)) return out
  const num = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined
  for (const [skillID, t] of Object.entries(v as Record<string, unknown>)) {
    if (!skillID || !t || typeof t !== "object") continue
    const rec = t as Record<string, unknown>
    const total = num(rec.total)
    if (total === undefined) continue
    const first = num(rec.firstUsedAt) ?? 0
    const last = num(rec.lastUsedAt) ?? first
    out[skillID] = {
      total,
      userTriggers: num(rec.userTriggers) ?? 0,
      modelTriggers: num(rec.modelTriggers) ?? 0,
      errors: num(rec.errors) ?? 0,
      firstUsedAt: first || last,
      lastUsedAt: Math.max(first, last),
    }
  }
  return out
}

// ---------- 聚合（/skill-trail 报告统计） ----------

const SUMMARY_CONTEXTS_MAX = 8 // 每 skill 展示的近期触发摘录条数

/** 明细层窗口聚合（per-skill 计数 + 时间域）——healTotals 的对账基线 */
function windowTotalsOf(sessions: ReadonlyArray<{ sessionID: string; records: readonly SkillRecord[] }>): TotalsMap {
  const out: TotalsMap = {}
  for (const s of sessions ?? []) {
    for (const r of s?.records ?? []) {
      if (!r?.skillID) continue
      const t = out[r.skillID] ?? { total: 0, userTriggers: 0, modelTriggers: 0, errors: 0, firstUsedAt: r.ts, lastUsedAt: r.ts }
      out[r.skillID] = {
        total: t.total + 1,
        userTriggers: t.userTriggers + (r.trigger === "user" ? 1 : 0),
        modelTriggers: t.modelTriggers + (r.trigger === "model" ? 1 : 0),
        errors: t.errors + (r.status === "error" ? 1 : 0),
        firstUsedAt: Math.min(t.firstUsedAt, r.ts),
        lastUsedAt: Math.max(t.lastUsedAt, r.ts),
      }
    }
  }
  return out
}

/**
 * 累计层对账修复（读时投影，不回写 storage——避免与 flush 链的读-改-写竞争）：
 * 强制 lifetime ≥ 窗口计数。累计层可能因（a）旧版插件已写明细、尚无累计层；
 * （b）delta 落账失败后进程退出丢失——落后于明细层（实证 2026-11-04 报告：
 * opencode 窗口 4 vs 累计 2，lifetime.firstUsedAt 晚于窗口首条）。
 * 单向修复（逐字段 max、时间域 min/max）：lifetime 语义上 ⊇ 明细窗口（明细可
 * 裁剪、累计永不清算），低于是账目错误；高于是裁剪所致的正常态，反向不修
 * （无法区分裁剪与双计，宁保守）。副作用：空累计层 + 非空窗口时，heal 会为
 * 窗口内 skill 补录成账——unusedBasis 随之从"窗口判定"升为"终身判定"，语义
 * 更真（这些 skill 显然被触发过，不是"从未触发"）。
 */
export function healTotals(
  totals: TotalsMap | undefined,
  sessions: ReadonlyArray<{ sessionID: string; records: readonly SkillRecord[] }>,
): TotalsMap {
  const out: TotalsMap = { ...totals }
  for (const [skillID, w] of Object.entries(windowTotalsOf(sessions))) {
    const t = out[skillID]
    out[skillID] = t ? {
      total: Math.max(t.total, w.total),
      userTriggers: Math.max(t.userTriggers, w.userTriggers),
      modelTriggers: Math.max(t.modelTriggers, w.modelTriggers),
      errors: Math.max(t.errors, w.errors),
      firstUsedAt: Math.min(t.firstUsedAt, w.firstUsedAt),
      lastUsedAt: Math.max(t.lastUsedAt, w.lastUsedAt),
    } : w
  }
  return out
}


export interface SkillUsageSummary {
  skillID: string
  name?: string
  // 窗口层（明细 storage：滚动的最近 N 会话）
  total: number
  userTriggers: number
  modelTriggers: number
  errors: number
  sessions: number
  lastUsedAt: number
  firstUsedAt: number
  agents: Array<{ agent: string; count: number }>
  contexts: string[] // 去重后近期触发摘录（新→旧）
  // 累计层（终身计数，不受明细裁剪影响；无累计数据时回退窗口值）
  lifetime: SkillTotals
}

export interface TrailSummary {
  generatedAt: number
  sessionCount: number
  recordCount: number
  windowFrom?: number
  windowTo?: number
  skills: SkillUsageSummary[] // 累计次数降序
  unused: Array<{ id: string; name?: string }> // 从未触发（有累计层=终身缺席，否则窗口缺席）
  unusedBasis: "totals" | "window"
  availableCount: number // 可见 skill 总数（unused 判定的分母）；0 = 清单不可用，未触发判定失效
  lifetimeCoverage?: { from: number; to: number } // 累计层覆盖时间域
}

export function summarizeTrails(
  sessions: Array<{ sessionID: string; records: SkillRecord[] }>,
  available?: Array<{ id: string; name?: string }>,
  totals?: TotalsMap,
): TrailSummary {
  const acc = new Map<string, {
    name?: string; nameTs: number; total: number; user: number; model: number; errors: number
    last: number; first: number; sids: Set<string>; agents: Map<string, number>; contexts: Map<string, number>
  }>()
  let recordCount = 0
  let windowFrom: number | undefined
  let windowTo: number | undefined
  for (const s of sessions ?? []) {
    for (const r of s?.records ?? []) {
      if (!r?.skillID) continue
      recordCount++
      windowFrom = Math.min(windowFrom ?? r.ts, r.ts)
      windowTo = Math.max(windowTo ?? r.ts, r.ts)
      const e = acc.get(r.skillID) ?? {
        name: undefined, nameTs: 0, total: 0, user: 0, model: 0, errors: 0,
        last: 0, first: Number.POSITIVE_INFINITY, sids: new Set<string>(), agents: new Map<string, number>(), contexts: new Map<string, number>(),
      }
      e.total++
      if (r.trigger === "user") e.user++
      else if (r.trigger === "model") e.model++
      if (r.status === "error") e.errors++
      if (r.ts > e.last) e.last = r.ts
      if (r.ts < e.first) e.first = r.ts
      e.sids.add(s.sessionID)
      if (r.agent) e.agents.set(r.agent, (e.agents.get(r.agent) ?? 0) + 1)
      if (r.name && r.ts >= e.nameTs) {
        e.name = r.name
        e.nameTs = r.ts
      }
      if (r.prompt && !e.contexts.has(r.prompt)) e.contexts.set(r.prompt, r.ts)
      acc.set(r.skillID, e)
    }
  }
  // 累计层：窗口外的 skill（会话已被裁剪）也要成行——lifetime 有账就上表
  const ids = new Set<string>([...acc.keys(), ...Object.keys(totals ?? {})])
  const skills = [...ids].map((skillID) => {
    const e = acc.get(skillID)
    const lt = totals?.[skillID]
    const lastUsedAt = Math.max(e?.last ?? 0, lt?.lastUsedAt ?? 0)
    return {
      skillID,
      // 记录侧无名（tool 路未吃到 activated 补名）→ 回退 available 清单名
      name: e?.name ?? available?.find((s) => s?.id === skillID)?.name,
      total: e?.total ?? 0,
      userTriggers: e?.user ?? 0,
      modelTriggers: e?.model ?? 0,
      errors: e?.errors ?? 0,
      sessions: e?.sids.size ?? 0,
      lastUsedAt,
      firstUsedAt: lt ? lt.firstUsedAt : (e?.first ?? lastUsedAt),
      agents: e
        ? [...e.agents.entries()].map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count)
        : [],
      contexts: e
        ? [...e.contexts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SUMMARY_CONTEXTS_MAX).map(([c]) => c)
        : [],
      lifetime: lt ?? {
        total: e?.total ?? 0,
        userTriggers: e?.user ?? 0,
        modelTriggers: e?.model ?? 0,
        errors: e?.errors ?? 0,
        firstUsedAt: e?.first ?? lastUsedAt,
        lastUsedAt: lastUsedAt,
      },
    }
  }).sort((a, b) => b.lifetime.total - a.lifetime.total || b.lastUsedAt - a.lastUsedAt)

  const usedEver = new Set<string>([...ids])
  const unusedBasis: "totals" | "window" = totals && Object.keys(totals).length > 0 ? "totals" : "window"
  const unused = (available ?? [])
    .filter((s) => s?.id && !usedEver.has(s.id))
    .map((s) => ({ id: s.id, name: s.name }))

  let lifetimeCoverage: { from: number; to: number } | undefined
  if (totals && Object.keys(totals).length > 0) {
    const all = Object.values(totals)
    lifetimeCoverage = {
      from: Math.min(...all.map((t) => t.firstUsedAt)),
      to: Math.max(...all.map((t) => t.lastUsedAt)),
    }
  }
  return { generatedAt: Date.now(), sessionCount: sessions?.length ?? 0, recordCount, windowFrom, windowTo, skills, unused, unusedBasis, availableCount: available?.length ?? 0, lifetimeCoverage }
}

// ---------- HTML 报告（/skill-trail 命令产物；自包含：内联样式/数据/脚本，离线可用） ----------

function esc(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function fmtDate(ts: number | undefined): string {
  return typeof ts === "number" && ts > 0 ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "—"
}

export interface ReportPayload {
  summary: TrailSummary
  sessions: Array<{ sessionID: string; records: SkillRecord[] }> // 原始明细一并内嵌，页面即完整数据包
}

export function renderReportHTML(payload: ReportPayload): string {
  const { summary } = payload
  const dataJSON = JSON.stringify(payload).replace(/</g, "\\u003c") // 防 </script> 逃逸
  const rows = summary.skills.map((s) => {
    const haystack = [s.skillID, s.name, ...s.agents.map((a) => a.agent)].join(" ").toLowerCase()
    const lifetimeParts = [
      `${s.lifetime.total}`,
      s.lifetime.userTriggers > 0 ? `你@ ${s.lifetime.userTriggers}` : "",
      s.lifetime.modelTriggers > 0 ? `自动 ${s.lifetime.modelTriggers}` : "",
    ].filter(Boolean).join(" · ")
    return `      <tr data-skill data-haystack="${esc(haystack)}" data-user="${s.lifetime.userTriggers}" data-model="${s.lifetime.modelTriggers}" data-errors="${s.lifetime.errors}" data-total="${s.total}" data-lifetime="${s.lifetime.total}" data-last="${s.lastUsedAt}">
        <td class="skill"><span class="name">${esc(s.name || s.skillID)}</span><span class="id">${esc(s.skillID)}</span></td>
        <td class="num">${esc(lifetimeParts)}${s.lifetime.errors > 0 ? ` <span class="err">✗${s.lifetime.errors}</span>` : ""}</td>
        <td class="num">${s.total}${s.sessions > 0 ? ` <span class="dim">(${s.sessions}会话)</span>` : ""}</td>
        <td>${esc(fmtDate(s.lastUsedAt))}</td>
        <td class="dim">${esc(s.agents.slice(0, 3).map((a) => `${a.agent}×${a.count}`).join(", "))}</td>
        <td>${s.contexts.length ? `<details><summary>近期触发 (${s.contexts.length})</summary><ul>${s.contexts.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>` : '<span class="dim">—</span>'}</td>
      </tr>`
  }).join("\n")
  const unusedItems = summary.unused.map((u) => `<li><span class="name">${esc(u.name || u.id)}</span><span class="id">${esc(u.id)}</span></li>`).join("")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>skill-trail 使用报告</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; max-width: 1100px; }
  header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 20px; margin: 0; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 16px; }
  .chip { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
  nav { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  nav button, nav select, nav input, nav a.btn { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; text-decoration: none; cursor: pointer; }
  nav button[aria-pressed=true] { border-color: currentColor; font-weight: 600; }
  nav input { width: 160px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
  td.num { white-space: nowrap; }
  td.skill .name { font-weight: 600; display: block; }
  td.skill .id, .id { font-size: 11px; opacity: .55; font-family: ui-monospace, monospace; }
  .dim { opacity: .55; font-size: 12px; }
  .err { color: #d33; font-weight: 600; }
  details summary { cursor: pointer; font-size: 12px; opacity: .75; }
  details ul { margin: 4px 0 0; padding-left: 18px; }
  details li { font-size: 12px; opacity: .85; }
  section.unused { margin-top: 28px; }
  section.unused ul { columns: 2; margin: 8px 0 0; padding-left: 18px; }
  footer { margin-top: 28px; font-size: 12px; opacity: .6; }
</style>
</head>
<body>
<header><h1>skill 使用报告</h1><span class="dim">生成于 ${esc(fmtDate(summary.generatedAt))}</span></header>
<div class="chips">
  <span class="chip">窗口 ${summary.sessionCount} 会话 · ${summary.recordCount} 条</span>
  <span class="chip">窗口范围 ${esc(fmtDate(summary.windowFrom))} ~ ${esc(fmtDate(summary.windowTo))}</span>
  <span class="chip">被触发 ${summary.skills.length} 个</span>
  ${summary.availableCount > 0 ? `<span class="chip">可见 skill ${summary.availableCount} 个</span>` : '<span class="chip err">可用 skill 清单不可用——"从未触发"判定失效</span>'}
  <span class="chip">从未触发 ${summary.unused.length} 个（${summary.unusedBasis === "totals" ? "终身判定" : "仅窗口判定"}）</span>
  ${summary.lifetimeCoverage ? `<span class="chip">累计覆盖自 ${esc(fmtDate(summary.lifetimeCoverage.from))}</span>` : ""}
</div>
<nav>
  <button data-filter="all" aria-pressed="true">全部</button>
  <button data-filter="user">含你@</button>
  <button data-filter="model">含自动</button>
  <button data-filter="error">有报错</button>
  <button data-filter="dormant">窗口内未触发</button>
  <select id="sort" title="排序">
    <option value="lifetime">按累计次数</option>
    <option value="last">按最近使用</option>
    <option value="total">按窗口次数</option>
  </select>
  <input id="search" type="search" placeholder="搜索 skill / agent">
  <a class="btn" href="skill-trail-report.json" download>导出 JSON</a>
</nav>
<table>
  <thead><tr><th>Skill</th><th>累计触发</th><th>窗口触发</th><th>最近使用</th><th>Agents</th><th>触发情境</th></tr></thead>
  <tbody id="rows">
${rows}
  </tbody>
</table>
<section class="unused">
  <h2>从未触发（${summary.unusedBasis === "totals" ? "自累计统计开始" : "当前窗口内"}）</h2>
  ${unusedItems
    ? `<ul>${unusedItems}</ul>`
    : summary.availableCount === 0
      ? '<p class="err">可用 skill 清单不可用（skill.list 未取到数据）——无法判定"从未触发"。可设 SKILL_TRAIL_PROBE=1 重跑，探针会记录实际返回形态。</p>'
      : '<p class="dim">无——当前可见的 skill 都有触发记录。</p>'}
</section>
<footer>
  明细层 = 滚动窗口（防膨胀，供触发情境回看）；累计层 = 终身计数（不受裁剪影响，"从未触发"以此判定）。<br>
  数据内嵌本页（&lt;script id="trail-data"&gt;），离线可用；完整原始数据见导出 JSON。
</footer>
<script type="application/json" id="trail-data">${dataJSON}</script>
<script>
(function () {
  var tbody = document.getElementById("rows");
  var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
  var filter = "all", query = "";
  function visible(row) {
    if (filter === "user" && +row.getAttribute("data-user") === 0) return false;
    if (filter === "model" && +row.getAttribute("data-model") === 0) return false;
    if (filter === "error" && +row.getAttribute("data-errors") === 0) return false;
    if (filter === "dormant" && +row.getAttribute("data-total") !== 0) return false;
    if (query && row.getAttribute("data-haystack").indexOf(query) < 0) return false;
    return true;
  }
  function apply() { rows.forEach(function (r) { r.style.display = visible(r) ? "" : "none"; }); }
  function resort() {
    var by = document.getElementById("sort").value;
    var key = by === "last" ? "data-last" : by === "total" ? "data-total" : "data-lifetime";
    rows.sort(function (a, b) { return +b.getAttribute(key) - +a.getAttribute(key); });
    rows.forEach(function (r) { tbody.appendChild(r); });
  }
  Array.prototype.forEach.call(document.querySelectorAll("nav button[data-filter]"), function (btn) {
    btn.addEventListener("click", function () {
      document.querySelector("nav button[aria-pressed=true]").setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-pressed", "true");
      filter = btn.getAttribute("data-filter");
      apply();
    });
  });
  document.getElementById("search").addEventListener("input", function (e) {
    query = e.target.value.trim().toLowerCase();
    apply();
  });
  document.getElementById("sort").addEventListener("change", resort);
})();
</script>
</body>
</html>`
}

// ---------- 展示格式（TUI 侧栏行，窄栏友好） ----------

const MEMBER_TITLE_MAX = 24 // 成员标签里 title 截断上限（窄栏友好）
const TUI_CONTEXT_MAX = 16 // 触发情境截断上限（每 skill 一行,大概知道哪句触发即可）

function clip(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max)}…` : v
}

/**
 * 子会话展示标签：agent (title) —— 同名 Agent（如并行两个 build）靠 title 后缀消歧。
 * SessionInfo 的 agent 归属形态未定，多层防御（agentID / agent.id / agent）；
 * title 与 agent 同名或缺失时不加后缀；无 agent 退 title → 短 id。
 */
export function memberLabel(info: unknown, sid: string): string {
  const iv = obj(info)
  const agentViaObject = obj(iv.agent).id
  const agent = typeof iv.agentID === "string" ? iv.agentID
    : typeof agentViaObject === "string" ? agentViaObject
    : typeof iv.agent === "string" ? iv.agent
    : ""
  const title = typeof iv.title === "string" ? iv.title.trim().slice(0, MEMBER_TITLE_MAX) : ""
  if (agent && title && title !== agent) return `${agent} (${title})`
  return agent || title || (sid.length > 8 ? `…${sid.slice(-6)}` : sid)
}

export function formatTrailLine(rec: SkillRecord): string {
  const d = new Date(rec.ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const badge = rec.trigger === "user" ? "you" : rec.trigger === "model" ? "auto" : ""
  const err = rec.status === "error" ? " ✗" : ""
  const ctx = rec.prompt ? ` ←${clip(rec.prompt, TUI_CONTEXT_MAX)}` : ""
  return `${hh}:${mm} ${rec.name || rec.skillID}${badge ? ` (${badge})` : ""}${err}${ctx}`
}

// ---------- 工具 ----------

/** 动态载荷防御视图（Google TS 任意型禁令的落地件）：非对象一律视作空记录，
 *  字段取回 unknown 后仍需 typeof/str/num 收窄——不可信数据（transcript、事件、
 *  storage 读数）在逻辑层全部以此收口，不做属性直达。 */
export function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

export { str }

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
}
