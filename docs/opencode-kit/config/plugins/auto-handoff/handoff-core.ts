// auto-handoff 纯逻辑层（handoff-core.ts）——2026-11-03 治理轮从 auto-handoff.ts v0.22
// 搬迁建层。v0.27 去模型化轮（2026-11-04）：入参 command+text → agent+prompt，models.json
// worker 档单源整体退役（分层定调：模型选择归 agent 配置/宿主配置，插件只做编排）。
// v0.28 接力链轮（2026-11-10 用户需求）：create 落 metadata 链路（relay.parent → 原会话
// id）——接力会话天生记住「从哪来」，TUI 半接力链面板靠此走链（宿主面 Session.CreateInput
// metadata 自由键值、durable、子会话/分叉继承——我们每次 create 自带，不被继承污染）。
// 弃 parentID 载体：parentID 会让新会话成为原会话的子任务（非 root），tabs.focus 只吃
// root 会话——会砸掉既有的 TUI 自动跟随。metadata 零层级副作用，链路重建归 TUI 半。
// v0.29 岗位模型轮（2026-11-10 用户反馈 luna-app 实证）：V2 语义下 agent 配置的 model
// 只对 subagent 子会话生效，primary 会话「选岗不改模型」——v0.27「岗配置自动生效」的
// 假设是空档（7 个 manager 主会话全落用户手选默认模型，分层失效）。修正：handoff 建的
// 新会话读目标岗 model（agent.list 的 AgentInfo.model，宿主解码为对象形态）非空则显式
// 落进 create（SessionCreateInput.model 同构）；模型来源仍是 agent 配置——插件只搬运不
// 自带模型单源（分层定调不变）。三态防线：不在宿主 model 清单 → 不落（回执注明沿用
// 默认）；带模型 create 失败 → 去模型重试（接力不中断）；清单不可读 → 照常落（坏了由
// 上一条重试兜底，同 listAgentNames「清单不可读不误杀」纪律）。
// 内容：agent 清单 / 六段模板 / 转录压缩 / 薄交接引擎 / 降级裁剪 / 结果文案。
// 分层纪律与 compaction.ts（handoff-compaction）、trail.ts（skill-trail）同款：
//   fs 与 console 经 CoreIO 注入，ctx 由调用方传入（测试传伪造即可），逻辑层零 npm
//   依赖，node --test 直跑；接线层（Plugin.define / tool 注册 / hook 保底）在
//   auto-handoff.ts。搬迁不改行为——语义出处与平台实证见 auto-handoff.ts 头注。
export interface CoreIO {
  log(message: string): void
}

/** 逻辑层宿主面（结构性最小面，Google TS：任意型零手写）：接线层传 SDK Plugin.Context，
 *  测试传伪造；成员全可选——运行时逐项探测，缺面走降级链（不阻断接力）。 */
export interface HandoffHost {
  agent?: { list?(): Promise<unknown> }
  model?: { list?(args: Record<string, unknown>): Promise<unknown> }
  session?: {
    context?(args: Record<string, unknown>): Promise<unknown>
    create?(args: Record<string, unknown>): Promise<unknown>
    synthetic?(args: Record<string, unknown>): Promise<unknown>
    switchAgent?(args: Record<string, unknown>): Promise<unknown>
    prompt?(args: Record<string, unknown>): Promise<unknown>
  }
  experimental?: { generate?: { text?(args: Record<string, unknown>): Promise<unknown> } }
  /** SDK 遗留平级位（experimental.generate 的别名），与 experimental 二选一探测 */
  generate?: { text?(args: Record<string, unknown>): Promise<unknown> }
}

export const HANDOFF_TOOL = "handoff_to"

/** 接力链 metadata 键（两半契约第二条，与 tui-core.ts 各持副本——勿改单边）：server 半
 *  create 时写 `metadata["relay.parent"] = 原会话 id`；TUI 半接力链面板读同键走链。
 *  契约第一条仍是 title 前缀「接力 @」（RELAY_TITLE_PREFIX）。 */
export const RELAY_PARENT_META = "relay.parent"

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e ?? "")
}

/** 动态载荷防御视图（Google TS 任意型禁令的落地件）：非对象视作空记录，字段取回 unknown
 *  后仍需 typeof/str 收窄——不可信数据（transcript、域方法返回值）以此收口。 */
export function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

// agent 清单（v0.27 前置校验用）：ctx.agent.list 无参调用合法（宿主 adapter 归一
// input??{}；LocationQuery 全可选），返回 {data:[{id,name,…}]}（AgentInfo——id 是
// create/switchAgent 的键，name 是展示名）；兼容裸数组与旧形态。id 与 name 并入
// 有效集：校验是 UX 守门（FAIL(3) 附清单防孤儿会话），不是 create 的正确性闸。
// 返回 undefined = 校验面不可用（域缺失/调用抛错/清单为空）→ 调用方跳过校验。
export async function listAgentNames(ctx: HandoffHost, io: CoreIO): Promise<string[] | undefined> {
  try {
    const res: unknown = await ctx?.agent?.list?.()
    const viaData = obj(res).data
    const arr = Array.isArray(res) ? res : Array.isArray(viaData) ? viaData : []
    const names = arr.flatMap((a) => [str(obj(a).id), str(obj(a).name)]).filter(Boolean)
    return names.length ? [...new Set(names)] : undefined // 空清单视为不可校验，不误杀
  } catch (e) {
    io.log(`[auto-handoff] agent 清单不可读，跳过前置校验：${errText(e)}`)
    return undefined
  }
}

// ---- 岗位模型落会话（v0.29 轮）----
// V2 语义（官方文档 agents 页 Model 节，luna-app 实证）：subagent 用其配置的 model，
// primary 会话的模型独立存储、选岗不改——空则吃用户上次手选。handoff 建的正是 primary
// 会话，岗模型必须显式落 create 才生效（SessionCreateInput.model 与 Agent.Info.model
// 解码后同构：{id, providerID, variant?}——插件不自行解析 provider/model#variant 字符串，
// 直接吃宿主解码结果）。

/** 会话模型引用（宿主面对象形态；variant 可缺席） */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** 模型引用防御视图：非对象或缺 providerID/id → undefined；variant 空串视作缺席。
 *  agent.list 返回值属动态载荷（实测可能偏离 .d.ts 形态），一律经此收口。 */
export function modelRefOf(v: unknown): ModelRef | undefined {
  const m = obj(v)
  const providerID = str(m.providerID)
  const id = str(m.id)
  if (!providerID || !id) return undefined
  const variant = str(m.variant)
  return variant ? { providerID, id, variant } : { providerID, id }
}

/** 模型引用展示串：provider/model#variant（variant 可缺席）——回执与日志用 */
export function modelRefLabel(ref: ModelRef): string {
  const base = `${ref.providerID}/${ref.id}`
  return ref.variant ? `${base}#${ref.variant}` : base
}

/** 读目标岗位配置的 model（按 id 匹配——name 是展示名可与他岗 id 撞车，不作键）：
 *  岗无 model / 域缺失 / 清单没有该岗 → undefined（合法形态「继承宿主默认」，静默）；
 *  调用抛错 → undefined + 落日志（静默降级 ≠ 无声降级）。 */
export async function agentModelOf(ctx: HandoffHost, io: CoreIO, agent: string): Promise<ModelRef | undefined> {
  try {
    const res: unknown = await ctx?.agent?.list?.()
    const viaData = obj(res).data
    const arr = Array.isArray(res) ? res : Array.isArray(viaData) ? viaData : []
    for (const a of arr) {
      if (obj(a).id === agent) return modelRefOf(obj(a).model)
    }
  } catch (e) {
    io.log(`[auto-handoff] agent 清单不可读，岗位模型未应用：${errText(e)}`)
  }
  return undefined
}

/** 岗位模型存在性校验（防岗配置指向已下线/拼错的模型把新会话钉死在坏引用上）：
 *  model.list 按 providerID + modelID 匹配（id 冗余匹配——宿主两键同值，防形态漂移），
 *  variant 再对 variants[].id。三态：true 在册 / false 明确不在册 / undefined 校验面
 *  不可用（域缺失/抛错/空清单）——undefined 照常应用（不误杀），坏了归 create 重试兜底。 */
export async function modelExists(ctx: HandoffHost, io: CoreIO, ref: ModelRef): Promise<boolean | undefined> {
  try {
    const res: unknown = await ctx?.model?.list?.({})
    const viaData = obj(res).data
    const arr = Array.isArray(res) ? res : Array.isArray(viaData) ? viaData : []
    if (!arr.length) return undefined
    const entry = arr.find(
      (m) => str(obj(m).providerID) === ref.providerID && (str(obj(m).modelID) === ref.id || str(obj(m).id) === ref.id),
    )
    if (!entry) return false
    if (!ref.variant) return true
    const variants = obj(entry).variants
    const ids = (Array.isArray(variants) ? variants : []).map((v) => str(obj(v).id)).filter(Boolean)
    return ids.includes(ref.variant)
  } catch (e) {
    io.log(`[auto-handoff] model 清单不可读，跳过岗位模型校验（照常应用）：${errText(e)}`)
    return undefined
  }
}

// ---- 薄交接引擎（自含；六段模板面向接棒的下一位定制：只装当前接力目标，不预告下游）----

/** 转录界桩：拼 prompt 时插在焦点行之后、对话转录之前（焦点贴近转录，吃 recency）。 */
export const TRANSCRIPT_MARKER = "=== Conversation transcript (possibly truncated) ===\n"

// 薄交接提示词——尽量取 Matt handoff skill（~/.agents/skills/handoff/SKILL.md）英文原版：
// 三条内容规则为原句（不复制工件只引用 / 脱敏 / 按下一会话用途裁剪），仅两处适配：
// ①脱敏原句按仓库机械红线删了一个英文单词（语义不变）；②落盘指令不适用——skill 场景
// 写临时文件，本件产物由 gen.text 返回后经 synthetic 注入。六段骨架（英译）、接力步
// 聚焦（只装当前一步勿预告下游）、缺失段写 None、建议制 skill 段为本件自有契约——
// Matt 原版只规定 suggested skills 一段；保留骨架因离屏单发生成需确定形状，且薄交接是
// 新会话的唯一种子。
export const HANDOFF_TEMPLATE = `You are a handoff generator. The current session is about to hand its task over to a fresh session (a new agent taking the post). Write a handoff document summarising the conversation below so a fresh agent can continue the work.

Rules:
- Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.
- Redact sensitive information, such as API keys, passwords, or personally identifiable information.
- Tailor the doc to the relay focus stated below — what the next session will be used for. Cover that step only; do not pre-announce later steps (the user drives those).
- Write "None" for a section with nothing to report; never fabricate.

Output the document with these sections, in order (## level-2 headings):

## Project one-liner
What this session is working on, in one or two sentences.

## Current state
Branch and latest commit, ticket / milestone progress (as visible in the conversation).

## Key decisions from the conversation
Calls and trade-offs not captured in some artifact, plus what the user vetoed. One line each, with a short why.

## Environment gotchas
Traps hit and workarounds (encoding, platform differences, silent-failure kinds).

## Artifact map
Files / tickets the conversation touched, one sentence each on what is inside.

## Suggested skills
Which skills the next agent should call the Skill tool for — a suggestion list, not an exhaustive one (based on the [tool skill] lines in the transcript and the remaining work; unused-but-relevant ones count too), one short why each.
`

export function capText(s: string, max = 80000): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.15)
  return s.slice(0, head) + "\n…(middle truncated)…\n" + s.slice(s.length - (max - head))
}

// 工具调用压一行（名 + 入参摘要，输出不进转录）：skill 装载在会话里是 skill 工具调用，
// 不渲染则交接生成器看不见「用过哪些 skill」，建议 skill 段无从供料（handoff skill 契约 L10）。
// part 形状按 v2.2 实证：{ type:"tool", name, state:{ status, input(对象或流式 JSON 串) } }
export function toolLine(p: unknown): string | undefined {
  const pv = obj(p)
  if (pv.type !== "tool" || typeof pv.name !== "string") return undefined
  const state = obj(pv.state)
  let input: unknown = state.input
  if (typeof input === "string") {
    try {
      input = JSON.parse(input)
    } catch {
      // 保留原串
    }
  }
  const brief = input === undefined || input === null ? "" : JSON.stringify(input).slice(0, 160).replace(/\s+/g, " ")
  const status = typeof state.status === "string" ? state.status : "?"
  return `[tool ${pv.name}${status !== "completed" ? `(${status})` : ""}] ${brief}`
}

export function transcriptOf(messages: readonly unknown[] | undefined): string {
  const out: string[] = []
  for (const m of messages ?? []) {
    const mv = obj(m)
    let t = ""
    if (typeof mv.text === "string") t = mv.text
    else {
      const rawParts = mv.parts
      const rawContent = mv.content
      const arr = Array.isArray(rawParts) ? rawParts : Array.isArray(rawContent) ? rawContent : []
      for (const p of arr) {
        const pt = obj(p).text
        if (p && typeof pt === "string") t += pt + "\n"
        else {
          const tl = toolLine(p)
          if (tl) t += tl + "\n"
        }
      }
    }
    if (!t.trim()) continue
    const role = typeof mv.role === "string" ? mv.role : typeof mv.type === "string" ? mv.type : "?"
    out.push(`[${role}] ${t.trim()}`)
  }
  return out.join("\n\n")
}

// 交接失败时的最小指针包（不进 repo，只随新会话 synthetic 注入）
export function minimalHandoff(sid: string, agent: string, prompt: string): string {
  return [
    `本会话由 handoff_to 接力开启（岗位 @${agent}；原会话 ${sid} 已封箱，可在会话列表回看）。`,
    "开工指引：以下一条任务消息所指工件为准——spec / tickets / map 一律按文件现状读。",
    `用户原始需求：${prompt || "（见下一条任务消息）"}`,
  ].join("\n")
}

// 裁剪纯函数：boundID 之前的全部消息替换为单条提示（"断"但不失引导）。
// 仅降级链（同会话切岗）经 context hook 保底调用；主链（新会话）天然干净无需裁剪。
export function trimMessagesBefore(messages: readonly unknown[], boundID: string): readonly unknown[] {
  const idx = messages.findIndex((m) => obj(m).id === boundID)
  if (idx <= 0) return messages // 未命中或 bound 是首条 → 无可裁
  const kept = messages.slice(idx)
  const notice = {
    role: "user",
    content:
      "<context-boundary>此前对话段已按任务边界移出本请求（完整记录仍在会话历史中）；" +
      "跨段决策以仓库工件（spec/tickets/map）与本段消息为准。</context-boundary>",
  }
  return [notice, ...kept]
}

export async function lastMessageID(ctx: HandoffHost, sid: string): Promise<string | undefined> {
  try {
    const info = await ctx?.session?.context?.({ sessionID: sid })
    const raw = obj(info).messages
    const msgs: readonly unknown[] = Array.isArray(raw) ? raw : []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const id = obj(msgs[i]).id
      if (typeof id === "string") return id
    }
  } catch {
    // 读不到 → 不记边界（hook 不裁）
  }
  return undefined
}

export function handoffResult(err: unknown, kind: 2 | 3, agent: string): string {
  const reason = err instanceof Error ? err.message : String(err ?? "")
  if (kind === 3) {
    return `handoff FAIL(3 用法错误)：${reason || "参数缺失"}——检查参数后重试`
  }
  return `handoff FAIL(2 环境不可用)：${reason || "RPC 不可达"}——请用户手动切换到 @${agent} 岗位并下发任务文本，同样等效`
}

// 薄交接生成（A 视角离屏）：读原会话消息 + 接力焦点（@岗位 + 任务文本）→ 宿主默认模型
// 压缩（v0.27 去模型化：generate.text 不传 model——摘要模型归宿主配置，配坏了归环境修，
// 引擎失败由降级链兜底）。（焦点透传 = Matt「按参数裁剪」规则的插件形态）。
// context 返回形态（livefire 实证）：messages 数组本身（keys=0,1,…）；兼容 {messages} 包装。
export async function makeHandoff(io: CoreIO, ctx: HandoffHost, sid: string, focus = ""): Promise<string> {
  const info = await ctx?.session?.context?.({ sessionID: sid })
  const gen = ctx.experimental?.generate ?? ctx?.generate
  if (!gen?.text) throw new Error("generate 面不可用")
  const viaMessages = obj(info).messages
  const messages: readonly unknown[] = Array.isArray(info) ? info : Array.isArray(viaMessages) ? viaMessages : []
  if (messages.length === 0) throw new Error("原会话消息面为空")
  const focusBlock = focus ? `Relay focus (what the next session will be used for): ${focus}\n\n` : ""
  const prompt = HANDOFF_TEMPLATE + focusBlock + TRANSCRIPT_MARKER + capText(transcriptOf(messages))
  io.log(`[auto-handoff] 离屏生成交接摘要（${messages.length} 条消息压缩，长会话可能耗时）…`)
  const out: unknown = await gen.text({ prompt })
  const summary = str(obj(out).text).trim()
  if (!summary) throw new Error("交接摘要为空")
  return summary
}

/** 接力会话 title（两半唯一契约的前缀半）：「接力 @<agent> <简述>」——简述取 prompt
 *  压平空白后截 40 字，纯装饰（会话列表可读性）；tui.ts 的 RELAY_TITLE_PREFIX 只认
 *  「接力 @」前缀，不参与判据。 */
export function relayTitle(agent: string, prompt: string, maxBrief = 40): string {
  const base = `接力 @${agent}`
  const flat = prompt.trim().replace(/\s+/g, " ")
  if (!flat) return base
  const brief = flat.length > maxBrief ? flat.slice(0, maxBrief) + "…" : flat
  return `${base} ${brief}`
}

// E-final 主链：新会话（create 生而落 @agent 岗）+ synthetic 交接 + prompt 下发任务。
// create 级失败抛错由调用方降级。
// v0.21：create+synthetic 已成而任务下发失败不再上抛——返回 { s2, warning }，调用方
// 按 0 态带 ⚠ 警示处理（新会话语义已成立；上抛会触发同会话降级，制造第二个失败现场）。
// v0.27 去模型化：prompt 不带 model（任务下发无模型面）；create 的模型 v0.29 修正——
// 「岗配置自动生效」在 V2 只对 subagent 成立，primary 会话须显式落（见文件头 v0.29 注；
// 当年 livefire「回落坏默认模型 ECONNREFUSED」根因是环境默认模型配坏，归环境修的定调
// 不变——本轮仍无插件自带模型单源，只是把 agent 配置的 model 搬进 create）。
// title 固定「接力 @」前缀——tui 半靠此特征导航（两半唯一契约，勿改单边）。
// v0.28：create 同时落 metadata 链路（relay.parent = 原会话 id）——接力链面板的数据源；
// 旧宿主 create 不识 metadata 键也不炸（多余键被宿主忽略/剥离，链路缺失仅面板降级）。
// v0.29：create 携岗位 model（岗配置非空且过存在性校验）；带模型 create 失败 → 去模型
// 重试一次（接力不中断，回执注明沿用默认）——重试在「首调已建会话但响应丢失」的极端
// 双失败下可能多建一个干净接力会话，可接受（同 v0.21「不制造第二个失败现场」的取舍）。
// 返回值 model = 已落成的岗位模型展示串（仅当带模型 create 成功）；warning 汇总岗位
// 模型降级注记与任务下发警示。
export async function handoffToFresh(io: CoreIO, ctx: HandoffHost, sid: string, agent: string, prompt: string): Promise<{ s2: string; model?: string; warning?: string }> {
  let handoff: string
  try {
    handoff = await makeHandoff(io, ctx, sid, `@${agent}${prompt ? `：${prompt}` : ""}`)
  } catch (e) {
    io.log(`[auto-handoff] 交接引擎降级为最小指针包：${errText(e)}`)
    handoff = minimalHandoff(sid, agent, prompt) // 降级：只注最小指针包
  }
  const title = relayTitle(agent, prompt)
  // 岗位模型三态防线：不在册 → 不落；校验面不可用 → 照常落（create 重试兜底）
  const notes: string[] = []
  let ref = await agentModelOf(ctx, io, agent)
  if (ref) {
    const label = modelRefLabel(ref)
    if ((await modelExists(ctx, io, ref)) === false) {
      io.log(`[auto-handoff] 岗位模型 ${label} 不在宿主 model 清单——不落会话，沿用默认`)
      notes.push(`岗位模型 ${label} 不可用（不在宿主 model 清单）——新会话沿用默认模型`)
      ref = undefined
    }
  }
  const base: Record<string, unknown> = { title, agent, metadata: { [RELAY_PARENT_META]: sid } }
  let created: unknown
  let applied: ModelRef | undefined
  if (ref) {
    try {
      created = await ctx?.session?.create?.({ ...base, model: ref })
      applied = ref
    } catch (e) {
      const reason = errText(e)
      io.log(`[auto-handoff] create 带岗位模型 ${modelRefLabel(ref)} 失败（${reason}）——去模型重试，接力不中断`)
      notes.push(`岗位模型 ${modelRefLabel(ref)} 应用失败（${reason}）——新会话沿用默认模型`)
    }
  }
  if (created === undefined && applied === undefined) {
    created = await ctx?.session?.create?.(base) // 岗无模型 / 带模型失败重试（此处失败上抛交调用方降级）
  }
  const s2 = str(obj(created).id) || (typeof created === "string" ? created : "")
  if (!s2) throw new Error("create 未返回会话 id")
  try {
    await ctx?.session?.synthetic?.({ sessionID: s2, text: handoff })
  } catch (e) {
    io.log(`[auto-handoff] 交接注入失败（不阻断，任务 prompt 自带工件路标）：${errText(e)}`)
  }
  const warned = (reason: string): { s2: string; warning: string } => ({
    s2,
    warning:
      [
        ...notes,
        `任务文本未能下发（${reason}）——新会话 ${s2} 已建成并注入交接、已落 @${agent} 岗，` +
          "但未收到首轮任务；请进入该会话直接输入任务文本",
      ].join("；"),
  })
  const deliver = ctx?.session?.prompt
  if (typeof deliver !== "function") {
    io.log(`[auto-handoff] 新会话 ${s2} 已建成但宿主无 prompt 面——按 0 态带警示返回`)
    return warned("宿主无 session.prompt 面")
  }
  try {
    await deliver({ sessionID: s2, text: prompt })
  } catch (e) {
    const reason = errText(e)
    io.log(`[auto-handoff] 新会话 ${s2} 已建成但任务下发失败：${reason}——按 0 态带警示返回`)
    return warned(reason)
  }
  const modelLabel = applied ? modelRefLabel(applied) : ""
  io.log(
    `[auto-handoff] 接力完成：新会话 ${s2}（${title}）已开启并下发任务` +
      (modelLabel ? `（岗位模型 ${modelLabel} 已落会话）` : "") +
      "——TUI 应已自动跟随（tui 半），未跟随时可从会话列表手动切换",
  )
  const result: { s2: string; model?: string; warning?: string } = { s2 }
  if (modelLabel) result.model = modelLabel
  if (notes.length) result.warning = notes.join("；")
  return result
}
