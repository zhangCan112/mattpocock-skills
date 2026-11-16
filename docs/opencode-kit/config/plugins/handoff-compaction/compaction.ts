// handoff-compaction 纯逻辑层 —— 六段模板 / 完结态终答保全 / 转录压缩 / 压缩足迹统计 / smart-zone 水位 / 摘要落盘
//（无平台依赖：fs 与 console 经 WatcherIO 注入，node --test 直测；接线见 handoff-compaction.ts）
import { join } from "node:path"

// smart-zone 缺省水位线：Matt Pocock「smart zone / dumb zone」实践——约 100k tokens 起
// 注意力劣化，与宣传窗口无关（"around 100K is kind of my new marker… it doesn't
// matter whether you're using 1 million context window or 200K"，AI Engineer 演讲
// 《Full Walkthrough: Workflow for AI Coding》2026-04；其 AI Coding Dictionary 估
// dumb zone 常始于 125k–150k 且自认有争议）。v0.4 曾取更保守的 100k；v0.6.0 回调
// 150k（2026-11-03 用户拍板）——v0.5.1 计量修正后线对照真实单步上下文，150k 仍在该
// 区间带上缘、200k 窗口下留 50k 余量；要更紧的线用 smart_zone_tokens 自配。
export const DEFAULT_SMART_ZONE = 150_000

/** smart_zone_tokens 双形态阈值：绝对 tokens 或窗口百分比。这里的百分比是**触发点**
 * （在窗口 X% 处发起压缩），刻意区别于宿主 compaction.buffer 百分比的「留余量」语义
 * （"20%" 是压在 80% 满）——README 须写清两者区别，防混用。 */
export type SmartZoneSpec =
  | { readonly kind: "absolute"; readonly tokens: number }
  | { readonly kind: "percent"; readonly pct: number }

// 阈值解析：number > 0 → 绝对；合法百分比串（0 < pct ≤ 100）→ percent——越界（>100%）
// 是窗口 × pct 永不可达的死配置，按非法处理（2026-11-03 定夺）；其余（字符串数字 /
// 0 / 负 / 乱串 / 缺席）→ undefined，调用方降级 DEFAULT_SMART_ZONE 且不缓存
// （修好配置下个事件即生效）。严格匹配不 trim（"10 %" 不吃）。
export function parseSmartZone(v: unknown): SmartZoneSpec | undefined {
  if (typeof v === "number" && v > 0) return { kind: "absolute", tokens: v }
  if (typeof v === "string" && /^\d+(\.\d+)?%$/.test(v)) {
    const pct = Number.parseFloat(v.slice(0, -1))
    if (pct > 0 && pct <= 100) return { kind: "percent", pct }
  }
  return undefined
}

// smart_zone_tokens 提取与分档解析：v0.23.0 六档链的**单层**解析器（项目层与全局层各跑
// 一次，项目层先走——层内三档 agents > models 匹配 > active 兜底）。v0.22.0 的键级回落
// 语义原样继承：任何一档值非法视同缺键，落到下一档 / 下一层，不构成覆盖。
/** 已解析的 smart-zone 配置：形态 + 命中层与命中档（探针/日志可分辨走的是哪条路） */
export interface ResolvedZone {
  readonly spec: SmartZoneSpec
  readonly layer: "project" | "global"
  readonly matched: "agent" | "model" | "active"
}

// 单层解析：①agents.<name>（**项目层专属键**——全局层不读，2026-11-05 用户链「项目级别
// 内 agent 配置」）②profiles 声明序扫 models 匹配（"provider/id" 精确串，variant 不参与；
// 命中即止，值非法 / 缺值 → 继续扫下一池）③active 档兜底。身份缺席（ref/agent 为
// undefined——session.get 缺席 / 抛错）→ 对应档跳过，active 档不受影响。全档落空 →
// undefined（调用方试下一层 / 降级缺省）。
export function zoneOf(
  raw: unknown,
  ref: ModelRef | undefined,
  agent: string | undefined,
  layer: "project" | "global",
): ResolvedZone | undefined {
  const doc = obj(raw)
  if (layer === "project" && agent !== undefined) {
    const spec = parseSmartZone(obj(obj(doc.agents)[agent]).smart_zone_tokens)
    if (spec !== undefined) return { spec, layer, matched: "agent" }
  }
  const key = ref !== undefined ? `${ref.providerID}/${ref.id}` : undefined
  const profiles = obj(doc.profiles)
  if (key !== undefined) {
    for (const name of Object.keys(profiles)) {
      const prof = obj(profiles[name])
      const models = prof.models
      if (!Array.isArray(models) || !models.some((m) => m === key)) continue
      const spec = parseSmartZone(prof.smart_zone_tokens)
      if (spec !== undefined) return { spec, layer, matched: "model" }
    }
  }
  const active = doc.active
  const prof = typeof active === "string" ? obj(profiles[active]) : {}
  const spec = parseSmartZone(prof.smart_zone_tokens)
  return spec !== undefined ? { spec, layer, matched: "active" } : undefined
}

// ---------- 转录压缩（compaction hook 供料） ----------

/** 动态载荷防御视图（Google TS 任意型禁令的落地件）：非对象视作空记录，字段取回 unknown
 *  后仍需 typeof/str 收窄——不可信数据（transcript、事件载荷）以此收口。 */
export function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

export function contextTokens(tokens: unknown): number {
  const tv = obj(tokens)
  const cache = obj(tv.cache)
  const n = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0)
  return n(tv.input) + n(cache.read) + n(cache.write)
}

export function cap(s: string, max = 80000): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.15)
  return s.slice(0, head) + "\n…（中段截断）…\n" + s.slice(s.length - (max - head))
}

// 工具调用压一行（名 + 入参摘要，输出不进转录）：skill 装载在会话里是 skill 工具调用，
// 不渲染则生成器看不见「用过哪些 skill」，建议 skill 段无从供料（handoff skill 契约）
export function toolLine(p: unknown): string | undefined {
  const pv = obj(p)
  if (pv.type !== "tool" || typeof pv.name !== "string") return undefined
  const state = obj(pv.state)
  let input: unknown = state.input
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) // streaming 态 input 是 JSON 串
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
    out.push(`[${typeof mv.type === "string" ? mv.type : "?"}] ${t.trim()}`)
  }
  return out.join("\n\n")
}

// ---------- 压缩足迹统计（TUI 状态栏供料；数据源 = transcript 的压缩消息） ----------
// 形态按 SDK SessionMessageCompaction（Running | Completed | Failed 三态，status 字段区分；
// 一次压缩一条消息，running → completed/failed 原位迁移）——载荷按不可信动态数据收窄。
// transcript 是持久权威：压缩不清史（skill-trail 侧栏同款依赖），计数跨 TUI 重启不丢。

/** 会话压缩足迹：已完成 / 失败 / 进行中计数 + 最近一次已结算时刻 */
export interface CompactionTally {
  readonly completed: number
  readonly failed: number
  readonly running: number
  /** 最近一次已结算（completed/failed）压缩的 time.created（毫秒）；无则缺席 */
  readonly lastSettledAt?: number
}

export function compactionTally(messages: readonly unknown[]): CompactionTally {
  let completed = 0
  let failed = 0
  let running = 0
  let lastSettledAt: number | undefined
  for (const m of messages) {
    const mv = obj(m)
    if (mv.type !== "compaction") continue
    if (mv.status === "running") {
      running++
      continue
    }
    // status 缺席按已结算口径：type 已锚定「一次压缩发生过」，running/failed 是显式细化
    if (mv.status === "failed") failed++
    else completed++
    const t = obj(mv.time).created
    if (typeof t === "number" && t > 0 && (lastSettledAt === undefined || t > lastSettledAt)) lastSettledAt = t
  }
  return { completed, failed, running, ...(lastSettledAt !== undefined ? { lastSettledAt } : {}) }
}

/** 状态栏行文案：`Compacted N times (M failed) · last HH:MM · compacting…`；无压缩痕迹 →
 *  undefined（TUI 返回 null 不占位）。时刻取本地时区 HH:MM（trail.ts formatTrailLine 同款）。
 *  v0.13.0 起行文案英文（单复数：1 time / N times）。 */
export function formatCompactionLine(tally: CompactionTally): string | undefined {
  const parts: string[] = []
  if (tally.completed > 0 || tally.failed > 0) {
    let head = `Compacted ${tally.completed} ${tally.completed === 1 ? "time" : "times"}`
    if (tally.failed > 0) head += ` (${tally.failed} failed)`
    if (tally.lastSettledAt !== undefined) {
      const d = new Date(tally.lastSettledAt)
      head += ` · last ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }
    parts.push(head)
  }
  if (tally.running > 0) parts.push("compacting…")
  return parts.length > 0 ? parts.join(" · ") : undefined
}

// ---------- 会话 token 计费累计（TUI 状态栏第二行供料；数据源 = transcript 的 assistant 步） ----------

/** 会话计费累计 tokens：全部 assistant 步（TokenUsageInfo 五字段 input/output/reasoning/
 *  cache.read/cache.write 全计）逐条累加。**只增不减、压缩不重置**——压缩不清史
 *  （compactionTally 同款依赖），跨压缩的步全部在册；与「当前上下文水位」（最后一次
 *  压缩后的最新 assistant 步，官方 lastAssistantWithUsage 口径）刻意区分：水位随压缩
 *  回落、驱动 smart-zone 线；本值是账单视角的总会话消耗。钱数另有宿主
 *  data.session.cost()，token 计数不做价格加权。载荷按不可信动态数据收窄。
 *  与宿主 SessionUsage.add 累加器同口径（该累加器正是 v0.5.0 误用为触发信号的事故源
 *  ——用作计费展示正确，用作水位错误）。 */
export function sessionTokensTotal(messages: readonly unknown[]): number {
  let total = 0
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0)
  for (const m of messages) {
    const mv = obj(m)
    if (mv.type !== "assistant") continue
    const t = obj(mv.tokens)
    const cache = obj(t.cache)
    total += n(t.input) + n(t.output) + n(t.reasoning) + n(cache.read) + n(cache.write)
  }
  return total
}

/** 计费累计行文案：`Total N tokens`（≥1M 两位小数 M 缩写 / ≥1k 整数 k 缩写 / 原数）；
 *  0 → undefined（TUI 不占行——无 assistant 步的会话不计）。 */
export function formatTokensLine(total: number): string | undefined {
  if (total <= 0) return undefined
  if (total >= 1_000_000) return `Total ${(total / 1_000_000).toFixed(2)}M tokens`
  if (total >= 1_000) return `Total ${Math.round(total / 1_000)}k tokens`
  return `Total ${total} tokens`
}

// 六段骨架是本仓库自有契约；规则句采用 Matt Pocock handoff skill 上游原版（github.com/
//   mattpocock/skills · skills/productivity/handoff——本地 ~/.agents/skills/handoff 为其
//   fork，已逐字核对一致）：no-duplication 句逐字采用；redact 句仅限定词改 all（原词
//   撞仓库风格红线——特定英文单词禁用，见 AGENTS.md 第 8 条门禁，语义不变）；受众句
//   "so a fresh agent can continue the work" v0.18.0 回归逐字——v0.11.0 曾改写为「压缩
//   后的同一会话」，机制上站不住：token 零结转，压缩后的脑子除摘要+尾巴外一无所有，
//   「同一个会话」只是宿主层叙事（session id / 盘上转录 / TUI 线程），对当局者（继续
//   工作的那个脑子）而言就是换脑（2026-11-04 用户拍板回退，spec §17）；第六段说明句
//   受众同步 the next agent——新脑子是第一次装载，不是「再装载」；"the live thread:
//   what's in flight, why, and what's next" 借自其 docs 页，内容焦点保留；落盘句（生成器
//   不写文件，落盘归插件）与用户入参句（compaction hook 无入参）不适用，删。与
//   auto-handoff 的模板同源但各自独立演进、无对齐义务（v0.9.0）——本件定位仍是同一
//   Agent 的新陈代谢（宿主层会话原地继续），但文档读者按机制事实写成零记忆接棒者。
export const HANDOFF_TEMPLATE = `You are a handoff generator. The session is being compacted: the conversation below is about to be replaced by the document you write. Write a handoff document summarising the current conversation so a fresh agent can continue the work. It carries the live thread: what's in flight, why, and what's next.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact all sensitive information, such as API keys, passwords, or personally identifiable information.

Emit exactly six sections (## headings; write a missing section as "无" — never invent):

## 项目一句话
One or two sentences on what this session is working on and why.

## 当前状态
Branch and latest commit, uncommitted changes, ticket/milestone progress (as far as the conversation shows), plus the task in flight and the next step.

## 对话层的关键决定
Decisions not captured in a single file: direction calls, trade-offs, and what the user rejected. One line each with a one-line why.

## 环境陷阱
Pitfalls hit and their workarounds (encoding, platform differences, silent failures).

## 工件地图
Files and tickets the conversation touched, one "what's inside" sentence each.

## 建议 skill
Skills for the next agent to load — suggestions, not an exhaustive list (based on the [tool skill] lines in the conversation and the remaining work; keep used ones by relevance, include unused ones the next phase needs), one why each.

=== 对话记录（可能截断） ===
`

// ---------- 完结态最终回答原文保全（v0.17.0，2026-11-04 用户拍板） ----------
// 完结即压语义下，压缩时刻的末条 assistant 消息往往就是本轮工作的最终交付。宿主压缩
// 结构上永远保最新一条原文（entries.length-1 封顶，keep=0 亦然——opencode v2.2.5
// compaction.ts 考证），但交接文档自身不携带它；本插件理念 keep=0 时文档是唯一的结构化
// 载体，落盘工件（opencode-handoff-<sid>.md）亦据此留档。判定只认结构状态（末条
// assistant、有正文、无工具部件 = 回合终答），不做内容猜测（「像不像总结」是猜，猜就是
// spec §14 教训）；工作中态（带 tool 部件 / 提问未答 / 空转录）分文不加，维持六段原样。

/** 完结态判定 + 终答提取：从转录末尾回找，跳过 compaction 条目（链条压缩时上一轮摘要
 * 垫在真实消息后仍能落到终答）；末条 assistant 纯文本 → 逐字返回（多 text 部件拼接、
 * 首尾 trim）；其余（非 assistant / 含 tool 部件——回合还要继续，含宿主 step 边界的
 * 回合内压缩 / 正文空白 / 空转录）→ undefined。布尔倾向：宁可误判「工作中」（= 现状
 * 行为，安全侧）也不误判「完结」。顶层 text 与 parts/content 形态同 transcriptOf 的
 * 取舍（text 优先，parts 兜底）。载荷按不可信动态数据收窄（obj）。 */
export function finalAnswerOf(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const mv = obj(messages[i])
    if (mv.type === "compaction") continue
    if (mv.type !== "assistant") return undefined
    let text = typeof mv.text === "string" ? mv.text : ""
    const rawParts = mv.parts
    const rawContent = mv.content
    const arr = Array.isArray(rawParts) ? rawParts : Array.isArray(rawContent) ? rawContent : []
    let partText = ""
    for (const p of arr) {
      const pv = obj(p)
      if (pv.type === "tool") return undefined // 末条带工具部件 = 回合待续，不是终答
      if (typeof pv.text === "string") partText += pv.text + "\n"
    }
    if (!text) text = partText
    const trimmed = text.trim()
    return trimmed ? trimmed : undefined
  }
  return undefined
}

/** 交接文档收尾拼接：完结态在六段后机械追加第七段「最终交付（原文保全）」——逐字原文
 * 由插件拼接而非生成器转述（生成器可能改写/截断，正是要防的失效模式）。2026-11-04
 * 用户拍板：机械拼接、置于文末、不设长度上限（极端长终答抬高底座由底座护栏兜底）；
 * 工作中态 / 空白原文 → summary 原样直通（引用相等，分文不加）。拼接发生在
 * event.result 赋值前，压缩替换段与落盘文件自动同款。 */
export function withFinalAnswer(summary: string, answer: string | undefined): string {
  const a = answer?.trim()
  if (!summary || a === undefined || !a) return summary
  return `${summary}\n\n## 最终交付（原文保全）\n（完结回合最终回答逐字原文，由插件机械拼接，未经生成器改写）\n\n${a}`
}

/** 完结态给生成器的追加指令（拼在转录之后——长提示尾部的指令注意力强）：终答原文由
 * 插件逐字追加在六段之后，六段内引用即可、不要复述（防摘要+宿主尾巴之外再添一份）。 */
export const FINAL_ANSWER_NOTE =
  "\nNote: the final assistant answer of the completed turn will be appended verbatim after your six sections — reference it, do not restate it.\n"

export function splitModel(ref: string): { providerID: string; id: string } | undefined {
  const i = ref.indexOf("/")
  if (i <= 0 || i >= ref.length - 1) return undefined
  return { providerID: ref.slice(0, i), id: ref.slice(i + 1) }
}

/** 生成模型引用：gen.text 的 model 面（@opencode/schema Model.Ref 的结构子集） */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

// ---------- IO 面（接线层注入真实 fs / console；测试注入内存版） ----------

export interface WatcherIO {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  tmpRoot: string // 摘要落盘根目录（接线层传 os.tmpdir()）
  globalModelsPath: string // 全局层 models.json 绝对路径（接线层传 join(homedir(), ".config", "opencode", "models.json")；测试注入内存路径）
  log(message: string): void
  probe(entry: Record<string, unknown>): void // 冒烟探针（接线层 env 门控，默认静默）
  // v0.5 主动触发面（宿主域方法经接线层注入；缺席 / 抛错由逻辑层降级回落提醒）：
  compact(sessionID: string): Promise<unknown> // ctx.session.compact({ sessionID })
  sessionInfo(sessionID: string): Promise<unknown> // ctx.session.get → Session.Info（含 model?）
  modelList(): Promise<unknown> // ctx.model.list → { data: Model.Info[] }（limit.context = 窗口）
}

// 模型单源读取（项目层）：目标仓 .opencode/models.json（插件私有配置）优先，src/models.json
// 回落；坏 JSON / 读失败试下一布局；全部缺失返回 undefined（查不阻断）
async function readProjectModelsDoc(io: WatcherIO, cwd: string): Promise<unknown> {
  for (const rel of [join(".opencode", "models.json"), join("src", "models.json")]) {
    try {
      return JSON.parse(await io.readFile(join(cwd, rel)))
    } catch {
      // 试下一布局
    }
  }
  return undefined
}

// 模型单源读取（全局层，v0.22.0）：~/.config/opencode/models.json——与全局 opencode 配置同
// 目录，路径经 WatcherIO.globalModelsPath 注入（纯逻辑层零平台依赖，跨平台由接线层的
// os.homedir 保证）。三层链末位：项目层两布局之后的键级回落——项目文件在场但缺键 /
// 键非法时该键落到这里取，项目同键有效值覆盖全局（2026-11-05 用户定调「全局和项目都能
// 生效，项目的值可以覆盖全局」）。坏 JSON / 读失败返回 undefined（查不阻断）。
async function readGlobalModelsDoc(io: WatcherIO): Promise<unknown> {
  try {
    return JSON.parse(await io.readFile(io.globalModelsPath))
  } catch {
    return undefined
  }
}

// worker 档提取：单个 models.json 文档的 profiles.<active>.worker（model/variant）；
// 缺档 / 坏 model 串 → undefined（调用方回落下一层 / 压缩事件自带模型）
function workerModelOf(raw: unknown): ModelRef | undefined {
  const active = obj(raw).active
  const profiles = obj(obj(raw).profiles)
  const prof = typeof active === "string" ? profiles[active] : undefined
  const worker = obj(prof).worker
  const modelRef = obj(worker).model
  if (typeof modelRef !== "string" || !modelRef) return undefined
  const m = splitModel(modelRef)
  if (!m) return undefined
  const variant = obj(worker).variant
  return { ...m, variant: typeof variant === "string" && variant ? variant : undefined }
}

// worker 模型单源（v0.22.0 双层）：项目层 models.json 的 worker 档优先，全局层键级回落；
// 两层皆缺 → undefined（调用方回落压缩事件自带模型）
export async function resolveWorkerModel(io: WatcherIO, cwd: string): Promise<ModelRef | undefined> {
  const project = workerModelOf(await readProjectModelsDoc(io, cwd))
  if (project !== undefined) return project
  return workerModelOf(await readGlobalModelsDoc(io))
}

// 模型引用提取：载荷顶层 .model（Model.Ref：{ id, providerID, variant? }）→ 结构子集。
// 双重身份：压缩事件自带模型（SessionRequest.model——宿主为本次压缩已选好的模型，
// models.json 缺失时的兜底候选）与会话当前模型（Session.Info.model——百分比阈值的
// 窗口解析源）。载荷按不可信动态数据收窄（obj/str）。
export function eventModelRef(event: unknown): ModelRef | undefined {
  const ref = obj(obj(event).model)
  const providerID = str(ref.providerID)
  const id = str(ref.id)
  if (!providerID || !id) return undefined
  const variant = str(ref.variant)
  return { providerID, id, variant: variant || undefined }
}

// 模型窗口提取：model.list() 载荷（ModelListOutput 形态 { location, data: Model.Info[] }）
// 里按 provider/id 找条目，取 limit.context（正数才算——窗口是百分比阈值的换算基数，
// TokenUsageInfo 实证无窗口字段，2026-11-03 SDK 2.2.5 .d.ts 考证）。载荷按不可信
// 动态数据收窄（obj/str）。
export function modelWindowOf(list: unknown, providerID: string, id: string): number | undefined {
  const data = obj(list).data
  if (!Array.isArray(data)) return undefined
  for (const m of data) {
    const mv = obj(m)
    if (str(mv.providerID) === providerID && str(mv.id) === id) {
      const ctx = obj(mv.limit).context
      return typeof ctx === "number" && ctx > 0 ? Math.floor(ctx) : undefined
    }
  }
  return undefined
}

/** 接管候选：模型引用 + 来源（探针/日志可分辨走的是哪条路） */
export interface ModelCandidate {
  readonly ref: ModelRef
  readonly source: "models.json" | "event"
}

// 接管候选链：models.json worker 档优先，压缩事件自带模型兜底——「所有情况下都接管」
// 的落点（无 models.json 的项目也接管）。同三元组（provider/id/variant）去重；
// 两者皆缺 → 空链（唯一无法接管的模型面情形，调用方降级默认压缩）。
export function modelChain(worker: ModelRef | undefined, event: unknown): readonly ModelCandidate[] {
  const out: ModelCandidate[] = []
  if (worker) out.push({ ref: worker, source: "models.json" })
  const fallback = eventModelRef(event)
  const key = (r: ModelRef) => `${r.providerID}/${r.id}/${r.variant ?? ""}`
  const seen = new Set(out.map((c) => key(c.ref)))
  if (fallback && !seen.has(key(fallback))) out.push({ ref: fallback, source: "event" })
  return out
}

// ---------- smart-zone 主动触发 watcher（事件总线驱动；状态实例内聚） ----------
// triggered：滞回，单会话过线至发起一次（ended/failed 再武装；compact 抛错时保持占用
//   = 本会话降级为提醒语义，不再自动发起——域方法坏了本会话内不会自愈，避免每步重试）
// inflight：防抖，compaction.started→ended/failed 期间不再发起（宿主侧称 pending 会
//   merge，插件侧仍自防；会话压缩若永不终结则滞留——探针 skip-inflight 可诊断）
// peak：各会话单步上下文水位（step.ended 的 input+cache = 当次请求上下文，压缩后随
//   之下跌——usage.updated 是计费累计、压完不回落，v0.5.0 误用即全局无限压缩事故，
//   已弃用）。取周期内峰值；ended 再武装时清零（重新爬坡，不清会二次触发成环）；
//   failed 保留（上下文没变，重试语义）
// floor：压缩底座 = ended 后首个 step 的上下文（系统提示+工具+保留尾巴+摘要——压缩
//   所能达到的下限；本插件理念是宿主配 compaction.keep.tokens=0 尾巴缺席——README「keep
//   归零」节，插件面无控制点只能配置落地），随每次 ended 重测（#floorPending 标记）。线 ≤ 底座 → 压缩不可能
//   降到线下，发起只会成环：拦截（探针 skip-floor）+ 单会话 log 一次（#floorLogged）——
//   防小绝对线 / 小窗百分比线无限压缩
// （v0.21.0 defer-until-settled 整层拆除，2026-11-04 用户拍板「我要可以自动压的」：
//   v0.7.0 的在飞推迟判据——自身 turn / 自有 shell / 任一后代 child / 直接父 turn 任一
//   在飞即推迟（defer-busy）、完结事件在祖先后代链上重评补发起、无限等待——在长自主
//   回合上把绝对线架空：活不停就永不压，上下文一路涨到宿主兜底才动手。拆后过线的
//   那个 step 一结算即 compact()（宿主承诺排在下一安全点、先于等待中的 prompt——
//   spec §13 API 考证），在飞现场由六段模板第三段「the live thread: what's in flight」
//   承接——模板本就为该状态设计；v0.17 终答拼接只认完结态，进行态压缩不加第七段，
//   语义不变。配套状态 busy/parent/parentChecked/shellSids/shells/deferLogged 与事件面
//   session.created / execution.started|succeeded|failed / retry.scheduled / shell 四条
//   随拆（execution.interrupted 保留——Esc 取消判别）；滞回 / in-flight 防抖 / 底座
//   护栏 / ended-failed 再武装 / Esc 取消全部保留。定夺记录 spec §20。）
// userCancelled/cancelLogged：v0.16.0 用户中断取消（2026-11-04 用户报告「Esc 后压缩仍
//   自动再次触发」；v0.21.0 过线即压形态下语义保留）——execution.interrupted 的
//   reason:"user"（Esc，SDK api.d.ts 枚举 user/shutdown/superseded/inactivity，精确可辨）
//   = 用户对会话的明确喊停：Esc 之后的过线发起不再放行（#tryFire 取消闸门），在飞压缩
//   被掐掉的 failed 不再武装重试（重试语义只服务瞬态失败，用户取消后自动再发起正是
//   缺陷本身）。滞回保持占用 = 本轮降级为提醒语义（与 compact() 抛错降级同款），单次
//   取消说明给手动出路；粘至下次压缩成功结算（rearm resetPeak 翻篇）才恢复自动。溢出
//   兜底仍由宿主 buffer 承担——取消不会让上下文无限膨胀。非 user 中断不触发取消语义
//   （superseded 是新消息顶掉旧回合，其后紧跟新 execution.started，过线即压语义保持）。
// persisted：各会话最后落盘的摘要（防同摘要双落盘；再压缩出新摘要 → 覆盖写，tmpdir 始终是最新一版）
// zoneCache：已解析阈值（v0.23.0 六档链任一档命中）按组合键缓存——cwd + 会话模型引用 +
//   agent（任一变化即重解析，中途换模型 / 换岗自然换线）；全链落空不缓存（修好任一层
//   文件下个事件即生效）
// windowCache：模型窗口正缓存（provider/id 键——Model.Info.limit.context，实例生命周期内稳定）
// windowFailLogged：窗口解析失败的回落 log 每会话一次（重试静默进行，修好即自愈）

export class Watcher {
  readonly #triggered = new Set<string>()
  readonly #inflight = new Set<string>()
  readonly #peak = new Map<string, number>()
  readonly #floor = new Map<string, number>()
  readonly #floorPending = new Set<string>()
  readonly #floorLogged = new Set<string>()
  readonly #persisted = new Map<string, string>()
  readonly #zoneCache = new Map<string, ResolvedZone>()
  readonly #windowCache = new Map<string, number>()
  readonly #windowFailLogged = new Set<string>()
  // v0.16.0 用户中断取消状态（sid 键控；见 Watcher 段注 userCancelled 条）
  readonly #userCancelled = new Set<string>() // 用户 Esc 过（reason:"user"），本轮不再自动发起
  readonly #cancelLogged = new Set<string>() // 取消单次说明（每 arm 周期至多一条）

  readonly #io: WatcherIO

  constructor(io: WatcherIO) {
    this.#io = io
  }

  // 回落提醒（旧文案兜底）：自动发起失败 / 压缩失败时给用户的手动出路
  #remind(used: number, line: number, why: string): void {
    const message = `上下文约 ${Math.round(used / 1000)}k tokens，已过 smart-zone 线（${Math.round(line / 1000)}k）。${why}，建议 /compact 或交接（handoff）。`
    this.#io.log(`[handoff-compaction] ${message}`)
  }

  // 用户中断取消的单次说明（拦下发起 / failed 不重试两路共用，#cancelLogged 去重）：
  // 说清「为什么不动了」+ 手动出路，避免用户以为插件坏了在原地反复试
  #cancelNote(sid: string, peak: number, line: number): void {
    if (this.#cancelLogged.has(sid)) return
    this.#cancelLogged.add(sid)
    this.#io.log(
      `[handoff-compaction] 上下文约 ${Math.round(peak / 1000)}k tokens，已过 smart-zone 线（${Math.round(line / 1000)}k），但回合被用户中断——本轮不再自动压缩，需要腾挪上下文时请手动 /compact 或交接（handoff）`,
    )
  }

  // summary 落盘 + 路径可见（log 一行）；#persisted 记各会话最后写入的摘要——同摘要
  // 重放（hook 产出路 × compaction.ended 事件路）去重，单会话一份；再压缩出新摘要则
  // 覆盖写（tmpdir 始终最新）。写失败不标记 → 下个事件可重试；错误向上抛，由调用方
  // 决定降级文案（事件路静默 / hook 路打日志）
  async persistSummary(sid: string, summary: string): Promise<void> {
    if (!sid || !summary) return
    if (this.#persisted.get(sid) === summary) {
      this.#io.probe({ t: "persist", sid, outcome: "dedup" })
      return
    }
    const file = join(this.#io.tmpRoot, `opencode-handoff-${sid}.md`)
    try {
      await this.#io.writeFile(file, summary)
    } catch (e) {
      // 写失败不标记 → 下个事件可重试；错误向上抛
      this.#io.probe({ t: "persist", sid, outcome: "fail", error: e instanceof Error ? e.message : String(e) })
      throw e
    }
    this.#persisted.set(sid, summary)
    this.#io.probe({ t: "persist", sid, outcome: "wrote", path: file })
    this.#io.log(`[handoff-compaction] handoff 摘要已落盘：${file}`)
  }

  // 阈值解析（v0.23.0 六档链）：项目层（agents.<name> → profiles.models 匹配 → active
  // 兜底）整层先于全局层（models 匹配 → active 兜底），最后内置 DEFAULT_SMART_ZONE——
  // 2026-11-05 用户定调「项目 agent > 项目按模型 > 项目兜底 > 全局按模型 > 全局兜底 >
  // 插件默认」。双形态（number 绝对 / "10%" 百分比）各档通用；任何一档值非法视同缺键
  // 落下一档（键级回落，不构成覆盖）。身份源 = session.get 的 agent?/model?（Session.Info
  // 实证两字段同源同调；缺 agent → agents 档跳过，缺模型 → models 档跳过，active 档
  // 不受影响）。有效解析按组合键（cwd|模型|agent）缓存；全链落空不缓存。
  async #resolve(cwd: string, ref: ModelRef | undefined, agent: string | undefined): Promise<ResolvedZone | undefined> {
    return (
      zoneOf(await readProjectModelsDoc(this.#io, cwd), ref, agent, "project") ??
      zoneOf(await readGlobalModelsDoc(this.#io), ref, agent, "global")
    )
  }

  // 有效水位线：先取会话身份（模型引用 + agent，逐事件取——中途换模型 / 换岗即时换线，
  // 与百分比窗口的同源同调），再走六档链解析。绝对形态直取；百分比形态 = 会话当前模型
  // 窗口 × pct（窗口按 provider/id 正缓存）。窗口解析失败（身份缺席 / 域方法缺席 / 列表
  // 查不到）→ 回落绝对缺省，单会话 log 一次（重试静默，修好即自愈）。
  async #line(cwd: string, sid: string): Promise<number> {
    let ref: ModelRef | undefined
    let agent: string | undefined
    try {
      const info = await this.#io.sessionInfo(sid)
      ref = eventModelRef(info)
      agent = str(obj(info).agent) || undefined
    } catch {
      // 身份面缺席 / 抛错：agents 档与 models 档跳过，active / default 档不受影响
    }
    const key = `${cwd}|${ref !== undefined ? `${ref.providerID}/${ref.id}` : "-"}|${agent ?? "-"}`
    let resolved = this.#zoneCache.get(key)
    if (resolved === undefined) {
      resolved = await this.#resolve(cwd, ref, agent)
      if (resolved === undefined) {
        this.#io.probe({ t: "threshold", cwd, sid, value: DEFAULT_SMART_ZONE, source: "default" })
        return DEFAULT_SMART_ZONE // 不缓存：修好任一层文件下个事件即生效
      }
      if (resolved.spec.kind === "absolute") {
        this.#io.probe({ t: "threshold", cwd, sid, value: resolved.spec.tokens, source: resolved.layer, matched: resolved.matched })
      }
      this.#zoneCache.set(key, resolved)
    }
    const spec = resolved.spec
    if (spec.kind === "absolute") return spec.tokens
    let window: number | undefined
    if (ref !== undefined) {
      try {
        const wk = `${ref.providerID}/${ref.id}`
        window = this.#windowCache.get(wk)
        if (window === undefined) {
          window = modelWindowOf(await this.#io.modelList(), ref.providerID, ref.id)
          if (window !== undefined) this.#windowCache.set(wk, window)
        }
      } catch {
        window = undefined // 域方法缺席 / 抛错：窗口未知，下方回落
      }
    }
    if (window === undefined) {
      if (!this.#windowFailLogged.has(sid)) {
        this.#windowFailLogged.add(sid)
        this.#io.log(`[handoff-compaction] 百分比阈值窗口解析失败，回落缺省 ${Math.round(DEFAULT_SMART_ZONE / 1000)}k（会话 ${sid}）`)
      }
      this.#io.probe({ t: "threshold", cwd, sid, value: DEFAULT_SMART_ZONE, source: "default" })
      return DEFAULT_SMART_ZONE
    }
    const line = Math.round((window * spec.pct) / 100)
    this.#io.probe({ t: "threshold", cwd, sid, value: line, source: "percent", pct: spec.pct, window, matched: resolved.matched })
    return line
  }

  // 再武装：清触发标记。ended 清峰值（单步上下文已随压缩缩回，重新爬坡——不清会立即
  // 二次触发成环）并清底座、标记重测（压缩产物变了）；failed 保留峰值与底座（上下文
  // 没变，下个事件即重试发起）。ended 同时翻篇用户取消（#userCancelled/#cancelLogged）
  // ——压缩成功结算即新周期，上一轮的 Esc 不该压制下一轮的自动压缩。
  #rearm(sid: string, resetPeak: boolean): void {
    this.#triggered.delete(sid)
    const peak = this.#peak.get(sid) ?? 0
    if (resetPeak) {
      this.#peak.delete(sid)
      this.#floor.delete(sid)
      this.#floorPending.add(sid)
      this.#userCancelled.delete(sid)
      this.#cancelLogged.delete(sid)
    }
    this.#io.probe({ t: "trigger", sid, outcome: "rearm", peak, peakReset: resetPeak })
  }

  // 发起尾巴：用户取消 → in-flight 防抖 → 发起 / 降级。v0.21.0 起 step.ended 过线即直达
  // 此处（无在飞推迟——defer 层已拆，spec §20），step.ended 是唯一入口。
  async #tryFire(sid: string, peak: number, line: number): Promise<void> {
    if (this.#userCancelled.has(sid)) {
      // 用户 Esc 过（reason:"user"）：本轮不再自动发起。消费武装（#triggered 占用）防
      // 逐事件重复探测；单次说明给手动出路。粘至下次压缩成功结算（rearm resetPeak）。
      this.#triggered.add(sid)
      this.#io.probe({ t: "trigger", sid, outcome: "skip-cancelled", peak, line })
      this.#cancelNote(sid, peak, line)
      return
    }
    if (this.#inflight.has(sid)) {
      this.#io.probe({ t: "trigger", sid, outcome: "skip-inflight", peak, line })
      return
    }
    this.#triggered.add(sid) // 滞回：过线至 ended/failed 只发起一次
    try {
      await this.#io.compact(sid) // delivery 初版不传（吃宿主缺省，真机冒烟后再议）
      this.#io.probe({ t: "trigger", sid, outcome: "triggered", peak, line })
      this.#io.log(`[handoff-compaction] 上下文约 ${Math.round(peak / 1000)}k tokens，已过 smart-zone 线（${Math.round(line / 1000)}k），自动压缩已发起`)
    } catch (e) {
      // compact 域方法缺席 / 抛错：回落旧提醒文案；#triggered 保持占用 = 本会话降级
      // 为提醒语义（后续过线不再自动发起；手动压缩成功事件会再武装）
      this.#io.probe({ t: "trigger", sid, outcome: "fail", peak, line, error: e instanceof Error ? e.message : String(e) })
      this.#remind(peak, line, "自动压缩发起失败")
    }
  }

  // 事件面公共处理：任何一环失败静默降级，绝不向宿主抛错（会话不被打断）。
  // 每个事件发一条探针线（含 dataKeys / tokKeys 载荷形状——冒烟时回答"总线到底来什么"）。
  // 子代理会话的 usage 事件按 sessionID 独立到达——全部状态 sid 键控，天然各自独立滞回。
  async handleEvent(event: unknown, cwd: string): Promise<void> {
    try {
      const ev = obj(event)
      const type = ev.type
      const data = obj(ev.data)
      const dataKeys = Object.keys(obj(ev.data))
      if (type === "session.compaction.started") {
        // 防抖窗口开启（手动 / 自动压缩一视同仁——插件发起的触发随后也会走到这）
        const sid = data.sessionID
        if (typeof sid === "string") this.#inflight.add(sid)
        this.#io.probe({ t: "event", type, sid, dataKeys })
        return
      }
      if (type === "session.compaction.failed") {
        // 压缩失败：解锁防抖 + 再武装（峰值保留，下个事件重试）+ 仍在线上则回落提醒文案。
        // 用户取消在先（Esc 掐掉在飞压缩）→ 不再武装重试：滞回保持占用 = 本轮降级为提醒
        // 语义，单次取消说明（重试语义只服务瞬态失败，用户主动取消后自动再发起正是
        // v0.16.0 修的「Esc 后又自动压」缺陷）。
        const sid = data.sessionID
        if (typeof sid === "string") {
          this.#inflight.delete(sid)
          if (this.#userCancelled.has(sid)) {
            const peak = this.#peak.get(sid) ?? 0
            const line = await this.#line(cwd, sid)
            this.#triggered.add(sid)
            this.#io.probe({ t: "trigger", sid, outcome: "cancelled", peak })
            if (peak >= line) this.#cancelNote(sid, peak, line)
          } else {
            const line = await this.#line(cwd, sid)
            this.#rearm(sid, false)
            const peak = this.#peak.get(sid) ?? 0
            if (peak >= line) this.#remind(peak, line, "压缩失败")
          }
        }
        this.#io.probe({ t: "event", type, sid, dataKeys })
        return
      }
      if (type === "session.compaction.ended") {
        // 载荷 data.text 即摘要全文（failed 事件不落盘）；解锁防抖 + 再武装（峰值清零）
        const sid = data.sessionID
        if (typeof sid === "string") {
          this.#inflight.delete(sid)
          this.#rearm(sid, true)
          if (typeof data.text === "string") {
            this.#io.probe({ t: "event", type, sid, textLen: data.text.length, dataKeys })
            await this.persistSummary(sid, data.text.trim())
          } else {
            this.#io.probe({ t: "event", type, sid, dataKeys }) // 载荷形状异常——冒烟证据
          }
        } else {
          this.#io.probe({ t: "event", type, dataKeys })
        }
        return
      }
      if (type === "session.execution.interrupted") {
        // Esc 判别（v0.16.0 语义在 v0.21.0 过线即压形态下保留）：reason:"user"（SDK 枚举
        // user/shutdown/superseded/inactivity，精确可辨）= 用户喊停——此后本轮过线发起被
        // #tryFire 取消闸门拦下、在飞压缩被掐的 failed 不重试；非 user 中断不设取消。
        // 其余 execution.* / session.created / shell.* / retry.* 事件不再驱动任何状态
        // （defer 层已拆，spec §20），走尾部通用探针线。
        const sid = data.sessionID
        if (typeof sid === "string" && data.reason === "user") this.#userCancelled.add(sid)
        this.#io.probe({ t: "event", type, sid, dataKeys })
        return
      }
      if (type === "session.step.ended") {
        // 触发信号 = 单步 tokens（当次请求的 input+cache.read+cache.write，与宿主 due()
        // 的 measuredPrompt 同源语义——压缩后随上下文一起回落）。usage.updated 的 tokens
        // 是会话计费累计量（宿主 SessionUsage.add 逐调用累加、压缩不重置），拿它触发即
        // v0.5.0 全局无限压缩事故的根因，已弃用（该事件仍走通用探针线记形状）。
        const sid = data.sessionID
        const tokKeys = Object.keys(obj(data.tokens))
        if (typeof sid !== "string") {
          this.#io.probe({ t: "event", type, dataKeys, tokKeys }) // 缺 sid——冒烟证据
          return
        }
        const used = contextTokens(data.tokens)
        if (used <= 0) {
          this.#io.probe({ t: "event", type, sid, used, dataKeys, tokKeys }) // 无 token 数据——不构成信号
          return
        }
        if (this.#floorPending.has(sid)) {
          // ended 后首个 step：即压缩底座（系统提示+工具+保留尾巴+摘要）
          this.#floorPending.delete(sid)
          this.#floor.set(sid, used)
        }
        const floor = this.#floor.get(sid)
        const prev = this.#peak.get(sid) ?? 0
        if (used > prev) this.#peak.set(sid, used)
        const peak = this.#peak.get(sid) ?? 0
        const line = await this.#line(cwd, sid)
        const fire = !this.#triggered.has(sid) && peak >= line && line > (floor ?? 0)
        this.#io.probe({ t: "event", type, sid, used, peak, ...(floor !== undefined ? { floor } : {}), line, fire, dataKeys, tokKeys })
        if (!fire) {
          // 线 ≤ 底座：再压也降不到线下，发起只会成环——拦截 + 单次说明
          if (peak >= line && floor !== undefined && line <= floor) {
            this.#io.probe({ t: "trigger", sid, outcome: "skip-floor", peak, line, floor })
            if (!this.#floorLogged.has(sid)) {
              this.#floorLogged.add(sid)
              this.#io.log(`[handoff-compaction] smart-zone 线（${Math.round(line / 1000)}k）不高于压缩底座（${Math.round(floor / 1000)}k）——压缩不可能降到线下，本会话不再自动发起；建议调高 smart_zone_tokens 或手动 /compact 交接`)
            }
          }
          return
        }
        await this.#tryFire(sid, peak, line) // 取消闸门 / in-flight 防抖 / 发起降级 尽在此尾巴
        return
      }
      this.#io.probe({ t: "event", type: typeof type === "string" ? type : "unknown", dataKeys })
    } catch {
      // 降级：watcher 异常不影响会话
    }
  }
}
