// handoff-compaction 纯逻辑层直测（node --test，零依赖零平台耦合——IO 注入）
// 覆盖面：六段模板结构锁、转录压缩（contextTokens/toolLine/transcriptOf/cap/splitModel）、
//   压缩足迹统计（compactionTally/formatCompactionLine：TUI 状态栏供料）、会话 token
//   计费累计（sessionTokensTotal/formatTokensLine：TUI 第二行供料，只增不减口径）、
//   接管候选链（eventModelRef/modelChain：worker 优先 + 事件模型兜底、三元组去重）、
//   smart-zone 主动触发（step.ended 单步上下文计量、过线即压——v0.21.0 拆除 v0.7.0 的
//   defer-until-settled，回合/子代理/shell/重试在飞不再推迟、滞回、in-flight
//   防抖、ended/failed 再武装、压缩底座护栏、compact 抛错回落提醒、usage.updated 计费
//   累计口径不驱动——v0.5.0 无限压缩事故回归）、双形态阈值（绝对 number / 百分比 "10%"、越界与非法降级、
//   窗口解析失败回落、读盘缓存/失败不缓存）、摘要落盘（persisted 防双落盘、写失败可重试）、
//   事件面绝不抛错、完结态最终回答原文保全（v0.17.0：
//   finalAnswerOf 结构判定 + withFinalAnswer 第七段机械拼接 + FINAL_ANSWER_NOTE 指令）。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  cap,
  compactionTally,
  contextTokens,
  DEFAULT_SMART_ZONE,
  eventModelRef,
  FINAL_ANSWER_NOTE,
  finalAnswerOf,
  formatCompactionLine,
  formatTokensLine,
  HANDOFF_TEMPLATE,
  modelChain,
  modelWindowOf,
  parseSmartZone,
  sessionTokensTotal,
  splitModel,
  toolLine,
  transcriptOf,
  withFinalAnswer,
} from "./compaction.ts"

// ---------- contextTokens ----------

test("contextTokens 求 input + cache.read + cache.write；非正数不计", () => {
  assert.equal(contextTokens({ input: 100, cache: { read: 50, write: 25 } }), 175)
  assert.equal(contextTokens({ input: 100, cache: { read: -5, write: 0 } }), 100)
  assert.equal(contextTokens({ input: "x", cache: { read: "y" } }), 0)
})

test("contextTokens 空载荷防御：null / 非对象 / 缺 cache → 0 或仅 input", () => {
  assert.equal(contextTokens(null), 0)
  assert.equal(contextTokens(42), 0)
  assert.equal(contextTokens({ input: 80 }), 80)
})

// ---------- splitModel ----------

test("splitModel 首斜杠切分；无斜杠 / 头斜杠 / 尾斜杠 → undefined", () => {
  assert.deepEqual(splitModel("zhipuai/glm-5.3"), { providerID: "zhipuai", id: "glm-5.3" })
  assert.deepEqual(splitModel("a/b/c"), { providerID: "a", id: "b/c" }) // 模型 ID 含斜杠：首个斜杠为准
  assert.equal(splitModel("noprovider"), undefined)
  assert.equal(splitModel("/glm"), undefined)
  assert.equal(splitModel("zhipuai/"), undefined)
  assert.equal(splitModel(""), undefined)
})

// ---------- cap ----------

test("cap 短串原样返回（引用相等）；超限头 15% + 尾 85% + 截断标记", () => {
  const s = "短串"
  assert.equal(cap(s), s)
  assert.equal(cap(s, 10), s) // 自定义上限同样短路
  const head = "H".repeat(3) // floor(20*0.15)
  const tail = "T".repeat(17)
  const out = cap(head + "M".repeat(10) + tail, 20)
  assert.equal(out, head + "\n…（中段截断）…\n" + tail)
})

// ---------- toolLine ----------

test("toolLine 对象入参压一行；status 非 completed 加标注、缺失记 (?)；无入参空摘要", () => {
  const base = (state: Record<string, unknown>) => ({ type: "tool", name: "skill", state })
  assert.equal(toolLine(base({ input: { id: "tdd" }, status: "completed" })), '[tool skill] {"id":"tdd"}')
  assert.equal(toolLine(base({ input: { id: "tdd" }, status: "pending" })), '[tool skill(pending)] {"id":"tdd"}')
  assert.equal(toolLine(base({ input: { id: "tdd" } })), '[tool skill(?)] {"id":"tdd"}')
  assert.equal(toolLine(base({ status: "completed" })), "[tool skill] ")
})

test("toolLine 流式 JSON 串入参解析；坏 JSON 串保留原文", () => {
  const streaming = { type: "tool", name: "skill", state: { input: '{"id":"tdd"}', status: "completed" } }
  assert.equal(toolLine(streaming), '[tool skill] {"id":"tdd"}')
  const broken = { type: "tool", name: "skill", state: { input: '{"id":', status: "completed" } }
  assert.equal(toolLine(broken), '[tool skill] "{\\"id\\":' + '"') // 原串 JSON.stringify：首尾引号 + 内引号转义
})

test("toolLine 非 tool 部件 / 缺名 → undefined；入参摘要 160 截断 + 空白压平", () => {
  assert.equal(toolLine({ type: "text", text: "hi" }), undefined)
  assert.equal(toolLine({ type: "tool", state: { status: "completed" } }), undefined)
  const long = { type: "tool", name: "bash", state: { input: { cmd: "x".repeat(300) }, status: "completed" } }
  const line = toolLine(long)!
  assert.ok(line.length <= "[tool bash] ".length + 160)
  assert.ok(!/\n/.test(line))
  const spaced = toolLine({ type: "tool", name: "bash", state: { input: { cmd: "a\n\n  b" }, status: "completed" } })
  assert.equal(spaced, '[tool bash] {"cmd":"a\\n\\n  b"}'.replace(/\s+/g, " ")) // JSON 转义后无裸空白，压平幂等
})

// ---------- transcriptOf ----------

test("transcriptOf 顶层 text 优先；parts / content 兜底；文本与工具行混合；空消息跳过", () => {
  const msgs = [
    { type: "user", text: "  帮我压缩  " },
    { type: "assistant", parts: [{ type: "text", text: "正在处理" }, { type: "tool", name: "skill", state: { input: { id: "tdd" }, status: "completed" } }] },
    { type: "assistant", content: [{ type: "text", text: "content 形态" }] },
    { type: "user", parts: [{ type: "text", text: "   " }] }, // 纯空白 → 跳过
  ]
  assert.equal(
    transcriptOf(msgs),
    "[user] 帮我压缩\n\n[assistant] 正在处理\n[tool skill] {\"id\":\"tdd\"}\n\n[assistant] content 形态",
  )
})

test("transcriptOf 类型缺失记 [?]；空输入 / null 安全返回空串", () => {
  assert.equal(transcriptOf([{ text: "无类型" }]), "[?] 无类型")
  assert.equal(transcriptOf([]), "")
  assert.equal(transcriptOf(undefined), "")
})

// ---------- 压缩足迹统计（compactionTally / formatCompactionLine：TUI 状态栏供料） ----------

/** SDK SessionMessageCompaction 形态（Running|Completed|Failed 共用 type:"compaction" + status 区分；
 *  created 收 unknown——测试要喂坏载荷） */
const compactionMsg = (status: string, created: unknown, over: Record<string, unknown> = {}) => ({
  type: "compaction",
  id: `msg_${created}`,
  time: { created },
  status,
  reason: "auto",
  summary: "…",
  ...over,
})

test("compactionTally：type=compaction 按 status 分类计数；running 不进最近时刻；非压缩消息忽略", () => {
  const tally = compactionTally([
    { type: "user", text: "hi" },
    compactionMsg("completed", 1_000),
    compactionMsg("failed", 2_000),
    compactionMsg("running", 3_000),
    compactionMsg("completed", 1_500),
  ])
  assert.deepEqual({ ...tally }, { completed: 2, failed: 1, running: 1, lastSettledAt: 2_000 })
})

test("compactionTally 防御：空 / null / 垃圾载荷不计；status 缺席按已结算；坏时刻不进 lastSettledAt", () => {
  assert.deepEqual({ ...compactionTally([]) }, { completed: 0, failed: 0, running: 0 })
  assert.deepEqual({ ...compactionTally([null, 42, "x", {}, { type: "assistant" }]) }, { completed: 0, failed: 0, running: 0 })
  const noStatus = compactionTally([{ type: "compaction", time: { created: 5_000 } }])
  assert.deepEqual({ ...noStatus }, { completed: 1, failed: 0, running: 0, lastSettledAt: 5_000 }) // type 锚定压缩事件
  const noTime = compactionTally([compactionMsg("completed", "x"), compactionMsg("failed", -1)])
  assert.deepEqual({ ...noTime }, { completed: 1, failed: 1, running: 0 }) // 非正数时刻不算最近
})

test("formatCompactionLine：次数/失败/最近时刻拼行；进行中单列；单复数（1 time / N times）；零压缩 → undefined（TUI 不占位）", () => {
  const at = (h: number, m: number) => new Date(2026, 10, 3, h, m).getTime() // 本地时区构造，测试跨时区稳定
  assert.equal(formatCompactionLine({ completed: 0, failed: 0, running: 0 }), undefined)
  assert.equal(formatCompactionLine({ completed: 2, failed: 0, running: 0, lastSettledAt: at(14, 32) }), "Compacted 2 times · last 14:32")
  assert.equal(formatCompactionLine({ completed: 2, failed: 1, running: 0, lastSettledAt: at(9, 5) }), "Compacted 2 times (1 failed) · last 09:05")
  assert.equal(formatCompactionLine({ completed: 0, failed: 0, running: 1 }), "compacting…")
  assert.equal(formatCompactionLine({ completed: 1, failed: 0, running: 1, lastSettledAt: at(23, 59) }), "Compacted 1 time · last 23:59 · compacting…") // 单数
  assert.equal(formatCompactionLine({ completed: 0, failed: 1, running: 0 }), "Compacted 0 times (1 failed)") // 零次但失败过：复数
  assert.equal(formatCompactionLine({ completed: 3, failed: 0, running: 0 }), "Compacted 3 times") // 无时刻：只报次数
})

// ---------- 会话 token 计费累计（sessionTokensTotal / formatTokensLine：TUI 第二行供料） ----------

/** assistant 步真实形态（SessionMessageAssistant.tokens?: TokenUsageInfo 五字段） */
const assistantMsg = (tokens: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  type: "assistant",
  id: "msg_x",
  time: { created: 1_000 },
  ...over,
  tokens,
})

test("sessionTokensTotal：全部 assistant 步五字段累加（input+output+reasoning+cache 读写）；compaction 消息不打断累计", () => {
  const total = sessionTokensTotal([
    assistantMsg({ input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 100 } }), // 1650
    compactionMsg("completed", 2_000), // 压缩痕迹——不计入但不清零后续累计
    assistantMsg({ input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }), // 500
  ])
  assert.equal(total, 2150) // 跨压缩步全部在册（只增不减的账单口径）
})

test("sessionTokensTotal 防御：非 assistant 消息 / tokens 缺席 / 坏载荷 / 负数不计；空输入 → 0", () => {
  assert.equal(sessionTokensTotal([]), 0)
  assert.equal(sessionTokensTotal([null, 42, "x"]), 0)
  assert.equal(sessionTokensTotal([{ type: "assistant" }, assistantMsg({ input: "x", cache: null })]), 0) // tokens 缺席/坏形态 → 0
  assert.equal(sessionTokensTotal([assistantMsg({ input: -5, output: -1 })]), 0) // 负数不算（与 contextTokens 同防御）
  assert.equal(sessionTokensTotal([{ type: "user", tokens: { input: 999 } }]), 0) // 只有 assistant 步计费
})

test("formatTokensLine：k/M 缩写与原数；0 → undefined（无 assistant 步不占行）", () => {
  assert.equal(formatTokensLine(0), undefined)
  assert.equal(formatTokensLine(845), "Total 845 tokens")
  assert.equal(formatTokensLine(1_000), "Total 1k tokens")
  assert.equal(formatTokensLine(2_341_200), "Total 2.34M tokens")
  assert.equal(formatTokensLine(-1), undefined) // 防御：非正数不占行
})

// ---------- HANDOFF_TEMPLATE 结构锁（六段骨架 = 本件自有契约）+ 上游规则句锁 + 口吻锁 ----------

test("HANDOFF_TEMPLATE 六段二级标题按序 + 对话记录分隔标记 + Matt skill 上游规则句", () => {
  const sections = [...HANDOFF_TEMPLATE.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(sections, ["项目一句话", "当前状态", "对话层的关键决定", "环境陷阱", "工件地图", "建议 skill"])
  assert.ok(HANDOFF_TEMPLATE.includes("=== 对话记录（可能截断） ===")) // 收尾分隔标记：模板 + 转录 直接拼接的界桩
  assert.ok(HANDOFF_TEMPLATE.endsWith("=== 对话记录（可能截断） ===\n")) // 模板 + 转录 直接拼接
  // no-duplication 句逐字锁（上游 mattpocock/skills 原版，见 compaction.ts 模板注）
  assert.ok(HANDOFF_TEMPLATE.includes("Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead."))
  // 脱敏句（上游原版 + 唯一偏离：限定词改 all——风格门禁，语义不变）
  assert.ok(HANDOFF_TEMPLATE.includes("Redact all sensitive information, such as API keys, passwords, or personally identifiable information."))
})

test("HANDOFF_TEMPLATE 口吻锁：写给零记忆的接棒者（Matt 受众原味，v0.18.0 回归），非同会话续跑虚构", () => {
  assert.ok(HANDOFF_TEMPLATE.includes("so a fresh agent can continue the work")) // Matt 受众句逐字回归——token 零结转，当局者=新脑子
  assert.ok(HANDOFF_TEMPLATE.includes("Skills for the next agent to load")) // 当局者第一次装载，非「再装载」
  assert.ok(HANDOFF_TEMPLATE.includes("the live thread")) // 内容焦点保留：在飞什么、为什么、下一步
  // v0.11.0 的同会话续跑口吻必须绝迹（v0.18.0 反向锁）
  assert.ok(!HANDOFF_TEMPLATE.includes("this same session after compaction"))
  assert.ok(!HANDOFF_TEMPLATE.includes("addressed to yourself"))
  assert.ok(!HANDOFF_TEMPLATE.includes("Skills to load again after compaction"))
})

// ---------- 完结态最终回答原文保全（finalAnswerOf / withFinalAnswer / FINAL_ANSWER_NOTE，v0.17.0） ----------

test("finalAnswerOf 末条 assistant 纯文本（多 text 部件拼接、首尾 trim）→ 逐字返回；顶层 text 形态同", () => {
  const msgs = [
    { type: "user", text: "帮我做完 X" },
    { type: "assistant", parts: [{ type: "tool", name: "bash", state: { status: "completed" } }] },
    { type: "assistant", parts: [{ type: "text", text: "完成。" }, { type: "text", text: "共三处改动。" }] },
  ]
  assert.equal(finalAnswerOf(msgs), "完成。\n共三处改动。")
  assert.equal(finalAnswerOf([{ type: "assistant", text: "  顶层形态终答  " }]), "顶层形态终答")
})

test("finalAnswerOf 工作中态 → undefined：末条带 tool 部件（回合待续）/ 末条是 user（提问未答）/ 正文空白 / 空转录 / 垃圾载荷", () => {
  assert.equal(finalAnswerOf([{ type: "assistant", parts: [{ type: "text", text: "先看下" }, { type: "tool", name: "read", state: { status: "completed" } }] }]), undefined)
  assert.equal(finalAnswerOf([{ type: "assistant", parts: [{ type: "tool", name: "read", state: { status: "pending" } }] }]), undefined)
  assert.equal(finalAnswerOf([{ type: "user", text: "在吗" }]), undefined)
  assert.equal(finalAnswerOf([{ type: "assistant", parts: [{ type: "text", text: "   " }] }]), undefined)
  assert.equal(finalAnswerOf([]), undefined)
  assert.equal(finalAnswerOf([null, 42, {}]), undefined)
})

test("finalAnswerOf 末尾 compaction 条目跳过（链条压缩：上一轮摘要垫在真实消息后仍能落到终答）；全 compaction → undefined", () => {
  const tail = [
    { type: "assistant", parts: [{ type: "text", text: "终答" }] },
    { type: "compaction", status: "completed", summary: "…" },
  ]
  assert.equal(finalAnswerOf(tail), "终答")
  assert.equal(finalAnswerOf([{ type: "compaction", status: "completed" }]), undefined)
})

test("withFinalAnswer 完结态：六段后追加第七段（标题 + 机制说明 + 逐字原文收尾），不设长度上限（2026-11-04 拍板）", () => {
  const summary = "## 项目一句话\n…\n\n## 建议 skill\n…"
  const out = withFinalAnswer(summary, "最终回答全文")
  assert.ok(out.startsWith(summary)) // 前六段分毫不动
  assert.ok(out.includes("## 最终交付（原文保全）"))
  assert.ok(out.includes("（完结回合最终回答逐字原文，由插件机械拼接，未经生成器改写）"))
  assert.ok(out.endsWith("最终回答全文")) // 逐字收尾 = 原文未被触碰
  const long = "长".repeat(30_000) // 拍板不设限：远超曾议的 16k 上限也必须全文保全
  assert.ok(withFinalAnswer(summary, long).endsWith(long))
})

test("withFinalAnswer 工作中态 / 空白原文 → 摘要原样直通（引用相等，一个字不加）", () => {
  const summary = "## 项目一句话\n…"
  assert.equal(withFinalAnswer(summary, undefined), summary)
  assert.equal(withFinalAnswer(summary, "   "), summary)
})

test("FINAL_ANSWER_NOTE 指令锁：终答由插件逐字追加，六段内引用不复述（防摘要+尾巴之外再添一份）", () => {
  assert.ok(FINAL_ANSWER_NOTE.includes("appended verbatim"))
  assert.ok(FINAL_ANSWER_NOTE.includes("do not restate"))
})

test("DEFAULT_SMART_ZONE 降级线 150k（v0.6.0 起；Matt Pocock dumb-zone 起点带上缘）", () => {
  assert.equal(DEFAULT_SMART_ZONE, 150_000)
})

// ---------- parseSmartZone（smart_zone_tokens 双形态阈值解析） ----------

test("parseSmartZone：正数 → 绝对；合法百分比 → percent；越界/0%/负/乱串/字符串数字/缺席 → undefined", () => {
  assert.deepEqual(parseSmartZone(100_000), { kind: "absolute", tokens: 100_000 })
  assert.deepEqual(parseSmartZone("10%"), { kind: "percent", pct: 10 })
  assert.deepEqual(parseSmartZone("12.5%"), { kind: "percent", pct: 12.5 })
  assert.equal(parseSmartZone("120%"), undefined) // 越界：窗口 × 120% 不可达 = 死配置，按非法处理
  assert.equal(parseSmartZone("0%"), undefined)
  assert.equal(parseSmartZone("abc"), undefined)
  assert.equal(parseSmartZone("110000"), undefined) // 字符串数字不吃（与既有语义一致）
  assert.equal(parseSmartZone("10 %"), undefined) // 严格匹配，不 trim
  assert.equal(parseSmartZone(0), undefined)
  assert.equal(parseSmartZone(-1), undefined)
  assert.equal(parseSmartZone(undefined), undefined)
  assert.equal(parseSmartZone(null), undefined)
})

// ---------- Watcher：smart-zone 水位（session.step.ended 单步上下文驱动） ----------

import { join } from "node:path"
import {
  resolveWorkerModel,
  Watcher,
  zoneOf,
  type WatcherIO,
} from "./compaction.ts"

const WD = "WD"
/** 全局层 models.json 路径（接线层真实形态 = join(homedir(), ".config", "opencode", "models.json")；测试注入内存路径） */
const GMD = join("G", "opencode", "models.json")

/** models.json 真实形态：profiles.<active> 同级挂 smart_zone_tokens 与 worker.{model,variant} 子档 */
const modelsJSON = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    active: "glm",
    profiles: { glm: { smart_zone_tokens: 90_000, worker: { model: "zhipuai/glm-5.3", variant: "thinking" }, ...over } },
  })

/** 全局层 models.json 同款形态（v0.22.0：三层链末位，项目层键级覆盖它） */
const globalModelsJSON = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    active: "g",
    profiles: { g: { smart_zone_tokens: 180_000, ...over } },
  })

function fakeIO(
  files: Record<string, string> = {},
  domain: { sessions?: Record<string, unknown>; modelList?: unknown } = {},
) {
  const store = new Map(Object.entries(files))
  const reads: string[] = []
  const writes: Array<{ path: string; data: string }> = []
  const logs: string[] = []
  const probes: Array<Record<string, unknown>> = []
  const compacts: string[] = []
  const modelListReads: unknown[] = []
  const io: WatcherIO = {
    tmpRoot: join("T", "mp"),
    globalModelsPath: GMD,
    async readFile(path) {
      reads.push(path)
      const v = store.get(path)
      if (v === undefined) throw new Error("ENOENT")
      return v
    },
    async writeFile(path, data) {
      writes.push({ path, data })
      store.set(path, data)
    },
    log(message) {
      logs.push(message)
    },
    probe(entry) {
      probes.push(entry)
    },
    async compact(sessionID) {
      compacts.push(sessionID)
    },
    async sessionInfo(sessionID) {
      return domain.sessions?.[sessionID]
    },
    async modelList() {
      modelListReads.push(domain.modelList)
      return domain.modelList
    },
  }
  return { io, store, reads, writes, logs, probes, compacts, modelListReads }
}

const usageEvent = (sessionID: string, input: number) => ({
  type: "session.usage.updated",
  data: { sessionID, tokens: { input, cache: { read: 0, write: 0 } } },
})

/** session.step.ended 真实形状（探针 dataKeys 实证）：tokens 为当次调用的用量，非累计 */
const stepEvent = (sessionID: string, input: number) => ({
  type: "session.step.ended",
  data: {
    sessionID,
    assistantMessageID: "msg_1",
    finish: "stop",
    tokens: { input, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
  },
})

test("过线自动发起压缩一次；滞回内涨落不再发起；文案含峰值与水位线", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  await w.handleEvent(stepEvent("s1", 170_000), WD)
  await w.handleEvent(stepEvent("s1", 100_000), WD)
  assert.equal(f.compacts.length, 1) // 单会话至多发起一次（滞回）
  assert.equal(f.logs.length, 1)
  assert.ok(f.logs[0]!.startsWith("[handoff-compaction]"))
  assert.ok(f.logs[0]!.includes("160k")) // 过线那步的峰值
  assert.ok(f.logs[0]!.includes("150k")) // 缺省降级线
  assert.ok(f.logs[0]!.includes("自动压缩已发起"))
})

test("多会话滞回独立；线下来回不发起", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  await w.handleEvent(stepEvent("s2", 60_000), WD) // s2 线下
  await w.handleEvent(stepEvent("s2", 80_000), WD) // 仍线下
  await w.handleEvent(stepEvent("s2", 160_000), WD) // s2 过线 → 发起
  assert.equal(f.logs.length, 2)
})

test("阈值读 models.json active 档生效（.opencode 布局优先）", async () => {
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON() })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 120_000), WD) // 120k ≥ 90k 档位线
  assert.equal(f.logs.length, 1)
  assert.ok(f.logs[0]!.includes("90k"))
})

test("阈值有效值缓存：每 cwd 只读盘一次", async () => {
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON() })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 50_000), WD)
  await w.handleEvent(stepEvent("s1", 60_000), WD)
  await w.handleEvent(stepEvent("s2", 70_000), WD)
  assert.equal(f.reads.length, 1) // 首事件命中 .opencode 后进缓存
})

test("缺文件降级默认 150k 且不缓存（每事件重读三层布局）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  await w.handleEvent(stepEvent("s2", 10_000), WD)
  await w.handleEvent(stepEvent("s2", 20_000), WD)
  assert.equal(f.reads.length, 9) // 3 布局（项目 2 + 全局 1）× 3 事件，读失败不缓存
  assert.ok(f.logs[0]!.includes("150k"))
})

test("修好配置下个事件即生效；发起文案用历史峰值而非瞬时值", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 95_000), WD) // 95k < 150k 默认线，不提醒，但峰值已记
  f.store.set(join(WD, ".opencode", "models.json"), modelsJSON()) // 配置出现：线降为 90k
  await w.handleEvent(stepEvent("s1", 80_000), WD) // 瞬时 80k，峰值 95k ≥ 90k → 提醒
  assert.equal(f.logs.length, 1)
  assert.ok(f.logs[0]!.includes("95k")) // 峰值，不是瞬时 80k
  assert.ok(f.logs[0]!.includes("90k"))
})

test("坏 JSON 试下一布局（src/models.json 回落生效）", async () => {
  const f = fakeIO({
    [join(WD, ".opencode", "models.json")]: "{bad json",
    [join(WD, "src", "models.json")]: modelsJSON(),
  })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 120_000), WD)
  assert.equal(f.reads.length, 2) // .opencode 解析失败 → src 兜底
  assert.ok(f.logs[0]!.includes("90k"))
  await w.handleEvent(stepEvent("s2", 120_000), WD)
  assert.equal(f.reads.length, 2) // 有效值已缓存
})

test("active 档缺 smart_zone_tokens → 默认且不缓存；补键后下个事件生效", async () => {
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: undefined }) })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  assert.ok(f.logs[0]!.includes("150k")) // 缺键降级
  f.store.set(join(WD, ".opencode", "models.json"), modelsJSON()) // 补上 90k
  await w.handleEvent(stepEvent("s2", 95_000), WD) // 新会话，若被缓存则仍 150k 线不提醒（95k < 150k）
  assert.equal(f.logs.length, 2)
  assert.ok(f.logs[1]!.includes("90k"))
})

test("非法阈值（字符串数字 / 0 / 负数 / 越界百分比 / 乱串）按缺省处理", async () => {
  for (const v of ["110000", 0, -1, "120%", "0%", "abc"]) {
    const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: v }) })
    const w = new Watcher(f.io)
    await w.handleEvent(stepEvent("s1", 160_000), WD)
    assert.equal(f.compacts.length, 1, `值 ${String(v)} 应触发默认线压缩`)
    assert.ok(f.logs[0]!.includes("150k"))
  }
})

// ---------- models.json 全局层（v0.22.0：三层链，键级回落，项目覆盖全局） ----------

test("全局层单独生效：项目无配置 → 线取全局 180k；probe source global", async () => {
  const f = fakeIO({ [GMD]: globalModelsJSON() })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 155_000), WD) // 155k < 180k 全局线，不发起
  assert.equal(f.compacts.length, 0)
  await w.handleEvent(stepEvent("s1", 185_000), WD) // 过全局线 → 发起
  assert.equal(f.compacts.length, 1)
  assert.ok(f.logs[0]!.includes("180k"))
  assert.ok(f.probes.some((p) => p.t === "threshold" && p.source === "global" && p.value === 180_000))
})

test("项目层覆盖全局：同键项目有效值 90k 赢（disk）；项目层命中即短路，全局不被读", async () => {
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON(), [GMD]: globalModelsJSON() })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 95_000), WD) // 95k ≥ 90k 项目线
  assert.ok(f.logs[0]!.includes("90k"))
  assert.ok(f.probes.some((p) => p.t === "threshold" && p.source === "project" && p.matched === "active" && p.value === 90_000))
  assert.ok(!f.reads.includes(GMD)) // 键级短路：项目层供出有效值，全局层不读
})

test("键级回落：项目文件在场但缺 smart_zone_tokens → 该键落到全局层取 180k", async () => {
  const f = fakeIO({
    [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: undefined }),
    [GMD]: globalModelsJSON(),
  })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 185_000), WD)
  assert.equal(f.compacts.length, 1) // 185k ≥ 180k 全局补位线
  assert.ok(f.logs[0]!.includes("180k"))
})

test("项目非法值视同缺键（不是覆盖）：越级回落全局 180k", async () => {
  const f = fakeIO({
    [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: "120%" }),
    [GMD]: globalModelsJSON(),
  })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 185_000), WD)
  assert.ok(f.logs[0]!.includes("180k"))
})

test("全局层坏 JSON / active 档缺键 → 与缺席同路，回落缺省 150k", async () => {
  for (const v of ["{bad global", JSON.stringify({ active: "g", profiles: { g: {} } })]) {
    const f = fakeIO({ [GMD]: v })
    const w = new Watcher(f.io)
    await w.handleEvent(stepEvent("s1", 160_000), WD)
    assert.equal(f.compacts.length, 1, `值 ${v.slice(0, 12)} 应走默认线压缩`)
    assert.ok(f.logs[0]!.includes("150k"))
  }
})

test("全局层有效值同样按 cwd 缓存：首事件读满三层，后续事件零读盘", async () => {
  const f = fakeIO({ [GMD]: globalModelsJSON() })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 185_000), WD) // 2 项目布局 + 1 全局 = 3 读
  assert.equal(f.reads.length, 3)
  await w.handleEvent(stepEvent("s2", 190_000), WD)
  assert.equal(f.reads.length, 3) // 已缓存
})

test("全局层百分比形态：线 = 窗口 × pct（项目无配置时取全局 10%）", async () => {
  const f = fakeIO(
    { [GMD]: globalModelsJSON({ smart_zone_tokens: "10%" }) },
    {
      sessions: { s1: { model: { providerID: "zhipuai", id: "glm-5.3" } } },
      modelList: { data: [{ providerID: "zhipuai", id: "glm-5.3", limit: { context: 1_000_000 } }] },
    },
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 99_000), WD) // 99k < 100k 线
  assert.equal(f.compacts.length, 0)
  await w.handleEvent(stepEvent("s1", 101_000), WD) // 过线 → 发起
  assert.equal(f.compacts.length, 1)
  assert.ok(f.logs[0]!.includes("100k"))
})

// ---------- 按 Agent / 按模型配置（v0.23.0：六档链——项目 agent > 项目模型 > 项目 active
// ---------- > 全局模型 > 全局 active > 硬编码缺省；身份源 = session.get 的 agent?/model?） ----------

/** v0.23 富配置文档：active 兜底 + models 匹配池（glm 200k / gpt 120k）+ agents 档（explore 60k） */
const richDoc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    active: "main",
    profiles: {
      main: { smart_zone_tokens: 90_000 },
      glm: { models: ["zhipuai/glm-5.3"], smart_zone_tokens: 200_000 },
      gpt: { models: ["openai/gpt-5"], smart_zone_tokens: 120_000 },
      ...over,
    },
    agents: { explore: { smart_zone_tokens: 60_000 } },
  })

/** 会话身份（session.get 的 agent?/model? 子集）：agent + 模型引用 */
const who = (agent?: string, providerID = "zhipuai", id = "glm-5.3", variant?: string) =>
  ({ agent, model: { providerID, id, ...(variant ? { variant } : {}) } })

test("zoneOf 单层矩阵：agent 档 > models 匹配 > active 兜底；身份缺席跳档；非法值越档；全局层不读 agents", () => {
  const glm = { providerID: "zhipuai", id: "glm-5.3" }
  // 项目层全命中路径
  assert.deepEqual(zoneOf(JSON.parse(richDoc()), glm, "explore", "project"), { spec: { kind: "absolute", tokens: 60_000 }, layer: "project", matched: "agent" })
  assert.deepEqual(zoneOf(JSON.parse(richDoc()), glm, "build", "project"), { spec: { kind: "absolute", tokens: 200_000 }, layer: "project", matched: "model" })
  assert.deepEqual(zoneOf(JSON.parse(richDoc()), { providerID: "anthropic", id: "claude-x" }, "build", "project"), { spec: { kind: "absolute", tokens: 90_000 }, layer: "project", matched: "active" })
  // 身份缺席：agent 档与 models 档都跳过（session.get 缺席 / 抛错的同路降级）
  assert.deepEqual(zoneOf(JSON.parse(richDoc()), undefined, undefined, "project"), { spec: { kind: "absolute", tokens: 90_000 }, layer: "project", matched: "active" })
  // 声明序首个命中：gpt 池排后，glm 池命中即止
  const both = { active: "main", profiles: { gpt: { models: ["zhipuai/glm-5.3", "openai/gpt-5"], smart_zone_tokens: 120_000 }, main: { smart_zone_tokens: 90_000 } } }
  assert.deepEqual(zoneOf(both, glm, "build", "global"), { spec: { kind: "absolute", tokens: 120_000 }, layer: "global", matched: "model" })
  // 模型匹配但值非法 / 缺值 → 越过该池落 active（非法视同缺键，不构成覆盖）
  const bad = { active: "main", profiles: { glm: { models: ["zhipuai/glm-5.3"], smart_zone_tokens: "abc" }, main: { smart_zone_tokens: 90_000 } } }
  assert.deepEqual(zoneOf(bad, glm, "build", "project"), { spec: { kind: "absolute", tokens: 90_000 }, layer: "project", matched: "active" })
  const noKey = { active: "main", profiles: { glm: { models: ["zhipuai/glm-5.3"] }, main: { smart_zone_tokens: 90_000 } } }
  assert.deepEqual(zoneOf(noKey, glm, "build", "project"), { spec: { kind: "absolute", tokens: 90_000 }, layer: "project", matched: "active" })
  // agents 键是项目层专属：全局层带 agents 也不读
  assert.deepEqual(zoneOf(JSON.parse(richDoc()), glm, "explore", "global"), { spec: { kind: "absolute", tokens: 200_000 }, layer: "global", matched: "model" })
  // agent 档值非法 → 越档到模型档
  const badAgent = { active: "main", profiles: { main: { smart_zone_tokens: 90_000 }, glm: { models: ["zhipuai/glm-5.3"], smart_zone_tokens: 200_000 } }, agents: { explore: { smart_zone_tokens: "120%" } } }
  assert.deepEqual(zoneOf(badAgent, glm, "explore", "project"), { spec: { kind: "absolute", tokens: 200_000 }, layer: "project", matched: "model" })
  // 空文档 / 垃圾载荷 → undefined
  assert.equal(zoneOf({}, glm, "explore", "project"), undefined)
  assert.equal(zoneOf(null, glm, "explore", "global"), undefined)
})

test("六档链集成（项目层三档）：agent 档 60k / 模型档 200k / active 兜底 90k 各自过线发起", async () => {
  const f = fakeIO(
    { [join(WD, ".opencode", "models.json")]: richDoc() },
    { sessions: { s1: who("explore"), s2: who("build"), s3: who("build", "anthropic", "claude-x") } },
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 65_000), WD) // 65k ≥ 60k agent 档
  await w.handleEvent(stepEvent("s2", 205_000), WD) // 205k ≥ 200k 模型档
  await w.handleEvent(stepEvent("s3", 95_000), WD) // 95k ≥ 90k active 兜底
  assert.equal(f.compacts.length, 3)
  const lines = f.probes.filter((p) => p.t === "threshold" && p.source === "project")
  assert.deepEqual(
    lines.map((p) => [p.sid, p.matched, p.value]),
    [
      ["s1", "agent", 60_000],
      ["s2", "model", 200_000],
      ["s3", "active", 90_000],
    ],
  )
})

test("跨层优先：项目 active 兜底压过全局模型档（项目层整层先于全局层）", async () => {
  const f = fakeIO(
    {
      [join(WD, ".opencode", "models.json")]: modelsJSON(), // 项目 active 90k
      [GMD]: JSON.stringify({ active: "g", profiles: { g: { smart_zone_tokens: 180_000 }, glm: { models: ["zhipuai/glm-5.3"], smart_zone_tokens: 200_000 } } }),
    },
    { sessions: { s1: who("build") } }, // 会话模型 glm 命中全局模型档——但项目层先到头
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 95_000), WD)
  assert.ok(f.logs[0]!.includes("90k"))
  assert.ok(f.probes.some((p) => p.t === "threshold" && p.source === "project" && p.matched === "active" && p.value === 90_000))
})

test("项目无配置时全局模型档生效；无匹配回落全局 active 兜底", async () => {
  const f = fakeIO(
    { [GMD]: JSON.stringify({ active: "g", profiles: { g: { smart_zone_tokens: 180_000 }, glm: { models: ["zhipuai/glm-5.3"], smart_zone_tokens: 200_000 } } }) },
    { sessions: { s1: who("build"), s2: who("build", "anthropic", "claude-x") } },
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 205_000), WD) // 全局模型档
  await w.handleEvent(stepEvent("s2", 185_000), WD) // 全局 active 兜底
  assert.equal(f.compacts.length, 2)
  assert.deepEqual(
    f.probes.filter((p) => p.t === "threshold" && p.source === "global").map((p) => [p.matched, p.value]),
    [
      ["model", 200_000],
      ["active", 180_000],
    ],
  )
})

test("身份缺席（session.get 无 agent / 无模型）→ agent 档与模型档跳过，active 兜底不受影响", async () => {
  const f = fakeIO(
    { [join(WD, ".opencode", "models.json")]: richDoc() },
    { sessions: { s1: {} } }, // 身份全缺（域方法缺席 / 抛错同路）
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 95_000), WD) // 95k ≥ 90k active
  assert.equal(f.compacts.length, 1)
  assert.ok(f.probes.some((p) => p.t === "threshold" && p.source === "project" && p.matched === "active"))
})

test("中途换模型即换线：缓存键含模型引用，同会话前后两段各自生效", async () => {
  const sessions: Record<string, unknown> = { s1: who("build") } // glm → 模型档 200k
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: richDoc() }, { sessions })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 205_000), WD) // 模型档 200k 过线 → 发起
  assert.ok(f.logs.some((l) => l.includes("200k")))
  await w.handleEvent(startedEvent("s1"), WD)
  await w.handleEvent(endedEvent("s1", "摘要"), WD) // 再武装（峰值清零）
  sessions.s1 = who("build", "anthropic", "claude-x") // 中途换模型 → active 兜底 90k
  await w.handleEvent(stepEvent("s1", 85_000), WD) // ended 后首步 = 新底座（85k < 90k 线，不发起）
  await w.handleEvent(stepEvent("s1", 95_000), WD) // 95k ≥ 90k 且线 > 底座 → 再发起
  assert.equal(f.compacts.length, 2)
  assert.ok(f.logs.some((l) => l.includes("自动压缩已发起") && l.includes("90k")))
})

test("agent 档支持百分比形态：线 = 窗口 × pct，percent 探针带 matched agent", async () => {
  const f = fakeIO(
    {
      [join(WD, ".opencode", "models.json")]: JSON.stringify({
        active: "main",
        profiles: { main: { smart_zone_tokens: 90_000 } },
        agents: { explore: { smart_zone_tokens: "10%" } },
      }),
    },
    {
      sessions: { s1: who("explore") },
      modelList: { data: [{ providerID: "zhipuai", id: "glm-5.3", limit: { context: 1_000_000 } }] },
    },
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 101_000), WD) // 1M × 10% = 100k 过线
  assert.equal(f.compacts.length, 1)
  assert.ok(f.logs[0]!.includes("100k"))
  assert.ok(f.probes.some((p) => p.t === "threshold" && p.source === "percent" && p.matched === "agent"))
})

test("variant 不参与模型匹配：带 variant 的会话模型仍按 provider/id 命中", async () => {
  const f = fakeIO(
    { [join(WD, ".opencode", "models.json")]: richDoc() },
    { sessions: { s1: who("build", "zhipuai", "glm-5.3", "thinking") } },
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 205_000), WD)
  assert.ok(f.probes.some((p) => p.t === "threshold" && p.source === "project" && p.matched === "model" && p.value === 200_000))
})

// ---------- modelWindowOf（model.list 载荷 → 会话模型窗口） ----------

test("modelWindowOf：按 provider/id 取 limit.context；缺 limit / 非正窗口 / 无匹配 / 非数组载荷 → undefined", () => {
  const list = {
    data: [
      { providerID: "zhipuai", id: "glm-5.3", limit: { context: 1_000_000, output: 8_192 } },
      { providerID: "anthropic", id: "claude-x" },
    ],
  }
  assert.equal(modelWindowOf(list, "zhipuai", "glm-5.3"), 1_000_000)
  assert.equal(modelWindowOf(list, "anthropic", "claude-x"), undefined) // 缺 limit
  assert.equal(modelWindowOf(list, "zhipuai", "nope"), undefined) // 无匹配
  assert.equal(modelWindowOf({}, "zhipuai", "glm-5.3"), undefined) // data 非数组
  assert.equal(modelWindowOf(null, "zhipuai", "glm-5.3"), undefined)
  const zeroWindow = { data: [{ providerID: "zhipuai", id: "m", limit: { context: 0 } }] }
  assert.equal(modelWindowOf(zeroWindow, "zhipuai", "m"), undefined) // 非正窗口不算
})

// ---------- 百分比阈值（线 = 会话模型窗口 × pct；窗口解析失败回落绝对缺省） ----------

test("百分比阈值：线 = 窗口 × pct（1M × 10% = 100k），与绝对值形态在 1M 窗口行为一致", async () => {
  const f = fakeIO(
    { [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: "10%" }) },
    {
      sessions: { s1: { model: { providerID: "zhipuai", id: "glm-5.3" } } },
      modelList: { data: [{ providerID: "zhipuai", id: "glm-5.3", limit: { context: 1_000_000 } }] },
    },
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 99_000), WD) // 线下（99k < 100k）
  assert.equal(f.compacts.length, 0)
  await w.handleEvent(stepEvent("s1", 101_000), WD) // 过线 → 发起
  assert.equal(f.compacts.length, 1)
  assert.ok(f.logs[0]!.includes("100k")) // 解析出的线恰为 100k
  const th = f.probes.find((p) => p.t === "threshold" && p.source === "percent")
  assert.deepEqual({ ...(th ?? {}) }, { t: "threshold", cwd: WD, sid: "s1", value: 100_000, source: "percent", pct: 10, window: 1_000_000, matched: "active" })
})

test("窗口解析失败（会话无模型）→ 回落绝对缺省 150k，单会话 log 一次；过线仍正常发起", async () => {
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: "10%" }) }) // 无 sessions → 会话模型缺失
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 50_000), WD) // 线解析即失败 → 回落 log 一次
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 缺省线 150k 过线 → 发起
  assert.equal(f.compacts.length, 1)
  assert.ok(f.logs.some((l) => l.includes("自动压缩已发起") && l.includes("150k")))
  assert.equal(f.logs.filter((l) => l.includes("回落")).length, 1) // 失败不缓存但 log 只一次
})

test("窗口正缓存：同模型第二次解析不再拉模型列表；会话模型逐事件取（独立会话各自查）", async () => {
  const f = fakeIO(
    { [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: "50%" }) },
    {
      sessions: {
        s1: { model: { providerID: "zhipuai", id: "glm-5.3" } },
        s2: { model: { providerID: "zhipuai", id: "glm-5.3" } },
      },
      modelList: { data: [{ providerID: "zhipuai", id: "glm-5.3", limit: { context: 200_000 } }] },
    },
  )
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 101_000), WD) // 线 = 200k × 50% = 100k
  await w.handleEvent(stepEvent("s2", 101_000), WD)
  assert.equal(f.compacts.length, 2)
  assert.equal(f.modelListReads.length, 1) // 窗口按 provider/id 缓存
})

// ---------- 主动触发状态机（过线 → compact；滞回 / in-flight 防抖 / 再武装） ----------

const startedEvent = (sessionID: string) => ({ type: "session.compaction.started", data: { sessionID, reason: "auto" } })
const failedEvent = (sessionID: string) => ({ type: "session.compaction.failed", data: { sessionID, reason: "auto", error: { message: "boom" } } })

test("过线触发一次；滞回不再发起；in-flight 跳过；ended 再武装 + 峰值清零，再过线再触发", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  assert.equal(f.compacts.length, 1) // 过线 → 发起（滞回标记占用）
  await w.handleEvent(stepEvent("s1", 170_000), WD)
  assert.equal(f.compacts.length, 1) // 滞回：涨落不再发起
  await w.handleEvent(endedEvent("s1", "摘要 A"), WD) // ended → 再武装 + 峰值清零 + 底座待测
  await w.handleEvent(stepEvent("s1", 25_000), WD) // 压缩后首个 step：上下文落回底座 25k，远在线下
  assert.equal(f.compacts.length, 1)
  await w.handleEvent(startedEvent("s1"), WD) // 压缩进行中（如手动发起）
  await w.handleEvent(stepEvent("s1", 180_000), WD) // 过线但 in-flight → 跳过
  assert.equal(f.compacts.length, 1)
  assert.ok(f.probes.some((p) => p.t === "trigger" && p.outcome === "skip-inflight" && p.sid === "s1"))
  await w.handleEvent(endedEvent("s1", "摘要 B"), WD) // ended → 解锁 + 再武装 + 底座重测
  await w.handleEvent(stepEvent("s1", 95_000), WD) // 底座 95k（< 150k 线）：线下不触发（旧峰值会成环）
  assert.equal(f.compacts.length, 1)
  await w.handleEvent(stepEvent("s1", 155_000), WD) // 重新过线（155k > 150k 线 > 95k 底座）→ 再压
  assert.equal(f.compacts.length, 2)
  assert.ok(f.probes.filter((p) => p.t === "trigger" && p.outcome === "rearm").length >= 2)
  assert.ok(f.probes.some((p) => p.t === "trigger" && p.outcome === "rearm" && p.sid === "s1" && p.peakReset === true))
})

test("触发探针 triggered：含 sid/peak/line", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  assert.deepEqual(f.probes.find((p) => p.t === "trigger"), { t: "trigger", sid: "s1", outcome: "triggered", peak: 160_000, line: 150_000 })
})

test("compact() 抛错 → 回落旧提醒文案，本会话不再自动发起；绝不向宿主抛错", async () => {
  const f = fakeIO()
  f.io.compact = async () => {
    throw new Error("domain unavailable")
  }
  const w = new Watcher(f.io)
  await assert.doesNotReject(w.handleEvent(stepEvent("s1", 160_000), WD))
  assert.ok(f.logs[0]!.includes("/compact 或交接")) // 旧提醒文案兜底
  await w.handleEvent(stepEvent("s1", 170_000), WD) // 降级为提醒语义：不再自动发起
  assert.equal(f.logs.filter((l) => l.includes("/compact 或交接")).length, 1)
  const fail = f.probes.find((p) => p.t === "trigger" && p.outcome === "fail")
  assert.ok(fail)
  assert.ok(String(fail!.error).includes("domain unavailable"))
})

test("compaction.failed → 再武装（峰值保留）+ 回落提醒；下个事件再触发（重试语义）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 发起
  assert.equal(f.compacts.length, 1)
  await w.handleEvent(startedEvent("s1"), WD)
  await w.handleEvent(failedEvent("s1"), WD) // 失败 → 再武装 + 提醒
  assert.ok(f.logs.some((l) => l.includes("/compact 或交接")))
  assert.ok(f.probes.some((p) => p.t === "trigger" && p.outcome === "rearm" && p.sid === "s1" && p.peakReset === false))
  await w.handleEvent(stepEvent("s1", 165_000), WD) // 峰值保留（≥线）→ 重试发起
  assert.equal(f.compacts.length, 2)
})

// ---------- v0.21.0 过线即压（defer-until-settled 整层拆除，用户拍板 2026-11-04「我要可以自动压的」） ----------
// v0.7.0 的在飞推迟（回合/子代理/shell/重试任一在飞即推迟、完结补发起、无限等待）在长
// 自主回合上把绝对线架空——活不停就永不压，上下文一路涨到宿主兜底才动手。拆后：过线的
// 那个 step 一结算即 compact()（宿主承诺排在下一安全点），任何在飞状态都不再推迟——
// 在飞现场由六段模板第三段「the live thread」承接，本就为该状态设计。滞回/防抖/底座
// 护栏/再武装/Esc 取消语义不变（v0.16 三测随语义改写）。定夺记录 spec §20。

const execStartedEvent = (sessionID: string) => ({ type: "session.execution.started", data: { sessionID } })
const execSucceededEvent = (sessionID: string) => ({ type: "session.execution.succeeded", data: { sessionID } })
const execInterruptedEvent = (sessionID: string, reason: string = "user") => ({
  type: "session.execution.interrupted",
  data: { sessionID, reason },
})
const retryScheduledEvent = (sessionID: string) => ({
  type: "session.retry.scheduled",
  data: { sessionID, assistantMessageID: "msg_1", attempt: 1, at: 123, error: { message: "rate" } },
})
const childCreatedEvent = (child: string, parent: string) => ({
  type: "session.created",
  data: { sessionID: child, parentID: parent, projectID: "p1", location: { directory: "/w" }, slug: "c", version: "2" },
})
const shellCreatedEvent = (shellID: string, sessionID: string) => ({
  type: "shell.created",
  data: { info: { id: shellID, status: "running", command: "npm run dev", cwd: "/w", shell: "bash", file: "/o", metadata: { sessionID } } },
})

test("回合进行中过线 → 当步立即发起（不再 defer）；滞回照常：后续步不再发", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(execStartedEvent("s1"), WD)
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 过线、回合在跑 → 当步即压
  assert.deepEqual(f.compacts, ["s1"])
  assert.ok(f.probes.some((p) => p.t === "trigger" && p.outcome === "triggered" && p.peak === 160_000))
  assert.equal(f.logs.filter((l) => l.includes("推迟")).length, 0) // defer 文案绝迹
  await w.handleEvent(stepEvent("s1", 170_000), WD) // 滞回：武装占用，涨不再发
  assert.equal(f.compacts.length, 1)
})

test("后台子代理在跑 → 父过线照样立即发起（child 判据已拆）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(childCreatedEvent("c1", "s1"), WD)
  await w.handleEvent(execStartedEvent("c1"), WD) // 子代理开跑（后台）
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 父过线 → 立即压
  assert.deepEqual(f.compacts, ["s1"])
})

test("子代理自身过线的 step 即压——自身与父回合都在跑也不推迟（parent 读结果竞态防护已拆）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(childCreatedEvent("c1", "s1"), WD)
  await w.handleEvent(execStartedEvent("s1"), WD) // 父回合（前台等子）
  await w.handleEvent(execStartedEvent("c1"), WD) // 子开跑
  await w.handleEvent(stepEvent("c1", 160_000), WD) // 子过线 → 立即压
  assert.deepEqual(f.compacts, ["c1"])
})

test("shell 在飞与重试待发 → 过线照样立即发起（shell/turn 判据已拆）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(shellCreatedEvent("sh1", "s1"), WD) // 工具后台命令在飞
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  assert.deepEqual(f.compacts, ["s1"])
  const g = fakeIO()
  const w2 = new Watcher(g.io)
  await w2.handleEvent(retryScheduledEvent("s2"), WD) // 重试待发
  await w2.handleEvent(stepEvent("s2", 160_000), WD)
  assert.deepEqual(g.compacts, ["s2"])
})

test("进行中立即发起时 compact 抛错 → 回落提醒（降级链不变）", async () => {
  const f = fakeIO()
  f.io.compact = async () => {
    throw new Error("domain unavailable")
  }
  const w = new Watcher(f.io)
  await w.handleEvent(execStartedEvent("s1"), WD)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  assert.ok(f.logs.some((l) => l.includes("/compact 或交接")))
  assert.ok(f.probes.some((p) => p.outcome === "fail"))
})

test("探针：execution.interrupted 记 event 线带 sid（Esc 判别证据）；created/shell 走通用线（无 sid）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(execInterruptedEvent("s1"), WD)
  await w.handleEvent(childCreatedEvent("c1", "s1"), WD)
  await w.handleEvent(shellCreatedEvent("sh1", "s1"), WD)
  assert.ok(f.probes.some((p) => p.t === "event" && p.type === "session.execution.interrupted" && p.sid === "s1"))
  assert.ok(f.probes.some((p) => p.t === "event" && p.type === "session.created"))
  assert.ok(f.probes.some((p) => p.t === "event" && p.type === "shell.created"))
})

// ---------- v0.5.1 计量修正（usage 累计 → step 单步上下文；压缩底座护栏） ----------

test("usage.updated 是计费累计口径（压缩后不回落）——不驱动触发，不产生日志", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(usageEvent("s1", 160_000), WD)
  await w.handleEvent(usageEvent("s1", 220_000), WD) // 持续累计过线
  assert.equal(f.compacts.length, 0) // v0.5.0 事故根因：累计过线 ≠ 上下文过线，绝不再触发
  assert.equal(f.logs.length, 0)
})

test("触发信号 = session.step.ended 单步上下文（当次请求 input+cache）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD)
  assert.equal(f.compacts.length, 1)
  assert.ok(f.logs[0]!.includes("160k"))
})

test("压缩后单步上下文回落（20k < 150k 线）不再触发——v0.5.0 无限压缩循环回归", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 过线 → 发起
  await w.handleEvent(startedEvent("s1"), WD)
  await w.handleEvent(endedEvent("s1", "摘要"), WD) // 压缩完成 → 上下文缩回底座
  await w.handleEvent(stepEvent("s1", 20_000), WD)
  await w.handleEvent(stepEvent("s1", 22_000), WD)
  assert.equal(f.compacts.length, 1) // 单步口径下不再发起（环断开）
})

test("线 ≤ 压缩底座（小绝对线 / 小窗百分比）→ 发起一次后拦截；log 单次不刷屏", async () => {
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON({ smart_zone_tokens: 1_000 }) })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 7_000), WD) // 底座未测（本会话未压缩过）→ 允许发起一次
  assert.equal(f.compacts.length, 1)
  await w.handleEvent(startedEvent("s1"), WD)
  await w.handleEvent(endedEvent("s1", "摘要"), WD)
  await w.handleEvent(stepEvent("s1", 8_000), WD) // 底座 8k ≥ 线 1k：压缩不可能降到线下 → 拦截
  await w.handleEvent(stepEvent("s1", 9_000), WD)
  assert.equal(f.compacts.length, 1)
  assert.equal(f.logs.filter((l) => l.includes("不再自动发起")).length, 1) // 单次说明
  assert.ok(f.probes.some((p) => p.t === "trigger" && p.outcome === "skip-floor" && p.sid === "s1"))
})

// ---------- resolveWorkerModel（compaction hook 模型单源） ----------

test("resolveWorkerModel 解析 worker 档（model + variant）；src 布局回落", async () => {
  const f = fakeIO({ [join(WD, "src", "models.json")]: modelsJSON() })
  assert.deepEqual(await resolveWorkerModel(f.io, WD), { providerID: "zhipuai", id: "glm-5.3", variant: "thinking" })
  const noVariant = fakeIO({ [join(WD, "src", "models.json")]: modelsJSON({ worker: { model: "zhipuai/glm-5.3" } }) })
  assert.deepEqual(await resolveWorkerModel(noVariant.io, WD), { providerID: "zhipuai", id: "glm-5.3", variant: undefined })
})

test("resolveWorkerModel 缺文件 / 缺 worker 档 / 坏 model 串 → undefined", async () => {
  assert.equal(await resolveWorkerModel(fakeIO().io, WD), undefined)
  const noWorker = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON({ worker: undefined }) })
  assert.equal(await resolveWorkerModel(noWorker.io, WD), undefined)
  const badRef = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON({ worker: { model: "无斜杠" } }) })
  assert.equal(await resolveWorkerModel(badRef.io, WD), undefined)
})

test("resolveWorkerModel 全局层回落：项目缺 worker 档 → 取全局；项目有 → 项目赢（键级同链）", async () => {
  const gDoc = (model: string) => JSON.stringify({ active: "g", profiles: { g: { worker: { model } } } })
  const projectNoWorker = fakeIO({
    [join(WD, ".opencode", "models.json")]: modelsJSON({ worker: undefined }),
    [GMD]: gDoc("zhipuai/glm-5.3-flash"),
  })
  assert.deepEqual(await resolveWorkerModel(projectNoWorker.io, WD), { providerID: "zhipuai", id: "glm-5.3-flash", variant: undefined })
  const projectWins = fakeIO({
    [join(WD, ".opencode", "models.json")]: modelsJSON(),
    [GMD]: gDoc("zhipuai/other"),
  })
  assert.deepEqual(await resolveWorkerModel(projectWins.io, WD), { providerID: "zhipuai", id: "glm-5.3", variant: "thinking" })
})

// ---------- eventModelRef / modelChain（接管候选链：所有情况都接管） ----------

test("eventModelRef 提取压缩事件自带模型（Model.Ref 形态）；variant 空串视 undefined", () => {
  assert.deepEqual(eventModelRef({ model: { providerID: "zhipuai", id: "glm-5.3", variant: "thinking" } }), {
    providerID: "zhipuai",
    id: "glm-5.3",
    variant: "thinking",
  })
  assert.deepEqual(eventModelRef({ model: { providerID: "zhipuai", id: "glm-5.3" } }), {
    providerID: "zhipuai",
    id: "glm-5.3",
    variant: undefined,
  })
  assert.deepEqual(eventModelRef({ model: { providerID: "zhipuai", id: "glm-5.3", variant: "" } }), {
    providerID: "zhipuai",
    id: "glm-5.3",
    variant: undefined,
  })
})

test("eventModelRef 防御：null / 非对象 / 缺 model / 字符串形态 / 缺字段 → undefined", () => {
  assert.equal(eventModelRef(null), undefined)
  assert.equal(eventModelRef(42), undefined)
  assert.equal(eventModelRef({}), undefined)
  assert.equal(eventModelRef({ model: "zhipuai/glm-5.3" }), undefined) // 字符串形态不吃：事件面是对象 Ref
  assert.equal(eventModelRef({ model: { providerID: "zhipuai" } }), undefined)
  assert.equal(eventModelRef({ model: { providerID: "", id: "glm-5.3" } }), undefined)
})

test("modelChain：worker 优先 + 事件模型兜底；无 models.json 单事件模型也能接管；全空 → 空链", () => {
  const worker = { providerID: "zhipuai", id: "glm-5.3", variant: "thinking" as const }
  const ev = { model: { providerID: "anthropic", id: "claude-x" } }
  assert.deepEqual(modelChain(worker, ev), [
    { ref: worker, source: "models.json" },
    { ref: { providerID: "anthropic", id: "claude-x", variant: undefined }, source: "event" },
  ])
  assert.deepEqual(modelChain(undefined, ev), [{ ref: { providerID: "anthropic", id: "claude-x", variant: undefined }, source: "event" }]) // 缺 models.json 不再降级
  assert.deepEqual(modelChain(undefined, {}), []) // 事件模型也缺失 → 空链（唯一不可接管的模型面情形）
})

test("modelChain 去重：同三元组的事件模型不重复入链；variant 不同则保留为第二候选", () => {
  const worker = { providerID: "zhipuai", id: "glm-5.3", variant: "thinking" as const }
  assert.equal(modelChain(worker, { model: { providerID: "zhipuai", id: "glm-5.3", variant: "thinking" } }).length, 1)
  assert.deepEqual(modelChain(worker, { model: { providerID: "zhipuai", id: "glm-5.3" } }), [
    { ref: worker, source: "models.json" },
    { ref: { providerID: "zhipuai", id: "glm-5.3", variant: undefined }, source: "event" },
  ])
})

// ---------- v0.16.0 用户中断取消（Esc = execution.interrupted reason:"user"；v0.21.0 过线即压形态下语义保留） ----------
// 缺陷史（2026-11-04 用户报告「Esc 后压缩仍自动再次发起」）在 defer 时代有两条路径；
// defer 拆除后仍成立的两条：①Esc 之后的过线发起不再放行；②在飞压缩被 Esc 掐掉 →
// compaction.failed 不再武装重试。修复语义不变：reason:"user" = 用户喊停——本轮（至
// 下次压缩成功结算）不再自动发起，单次说明给手动出路；非 user 中断（shutdown/
// superseded/inactivity）行为不变。

test("路径①：Esc 在过线之前 → 过线 step 不发起 + 单次取消说明；本轮粘性，后续过线也不再发", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(execStartedEvent("s1"), WD)
  await w.handleEvent(execInterruptedEvent("s1"), WD) // Esc（回合被喊停）
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 过线 → 取消闸门拦下
  assert.equal(f.compacts.length, 0)
  assert.deepEqual(f.probes.find((p) => p.t === "trigger" && p.outcome === "skip-cancelled"), {
    t: "trigger",
    sid: "s1",
    outcome: "skip-cancelled",
    peak: 160_000,
    line: 150_000,
  })
  assert.equal(f.logs.filter((l) => l.includes("用户中断")).length, 1) // 单次说明
  assert.ok(f.logs.some((l) => l.includes("/compact 或交接"))) // 手动出路在文案里
  // 本轮粘性：用户继续工作，后续过线也不再自动发起
  await w.handleEvent(stepEvent("s1", 170_000), WD)
  assert.equal(f.compacts.length, 0)
  assert.equal(f.logs.filter((l) => l.includes("用户中断")).length, 1) // 说明仍只一次
  // 压缩成功结算（如手动 /compact）→ 新周期：自动发起恢复
  await w.handleEvent(endedEvent("s1", "摘要 A"), WD)
  await w.handleEvent(stepEvent("s1", 25_000), WD) // 底座重测 25k（< 线）
  await w.handleEvent(stepEvent("s1", 155_000), WD) // 重新过线 → 再发起
  assert.equal(f.compacts.length, 1)
})

test("路径②：过线立即发起的压缩被 Esc 掐掉（failed）→ 不再武装重试；后续过线也不再发起", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(execStartedEvent("s1"), WD)
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 过线 → 立即发起
  assert.equal(f.compacts.length, 1)
  await w.handleEvent(startedEvent("s1"), WD) // 压缩在飞
  await w.handleEvent(execInterruptedEvent("s1"), WD) // Esc 掐掉压缩
  await w.handleEvent(failedEvent("s1"), WD) // 失败 → 不重试：无 rearm(false) 武装
  assert.ok(f.probes.some((p) => p.t === "trigger" && p.outcome === "cancelled" && p.sid === "s1"))
  assert.ok(!f.probes.some((p) => p.outcome === "rearm" && p.peakReset === false)) // 无重试武装
  assert.equal(f.logs.filter((l) => l.includes("用户中断")).length, 1) // 单次取消说明
  assert.ok(!f.logs.some((l) => l.includes("压缩失败"))) // 不再给「失败重试」语义文案
  // 后续过线（真实重试点）也不发起
  await w.handleEvent(stepEvent("s1", 165_000), WD)
  assert.equal(f.compacts.length, 1)
})

test("非用户中断（shutdown / superseded / inactivity）不取消：过线照常立即发起", async () => {
  for (const reason of ["shutdown", "superseded", "inactivity"]) {
    const f = fakeIO()
    const w = new Watcher(f.io)
    await w.handleEvent(execStartedEvent("s1"), WD)
    await w.handleEvent(execInterruptedEvent("s1", reason), WD) // 非 user 中断：不设取消
    await w.handleEvent(stepEvent("s1", 160_000), WD) // 过线 → 照常立即发起
    assert.equal(f.compacts.length, 1, `reason=${reason} 不应取消`)
    assert.ok(!f.probes.some((p) => p.outcome === "skip-cancelled"))
    assert.equal(f.logs.filter((l) => l.includes("用户中断")).length, 0)
  }
})

test("Esc 时未过线（无关中断）：之后爬坡过线 → 本轮同样不自动发起，单次说明", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(execStartedEvent("s1"), WD)
  await w.handleEvent(stepEvent("s1", 50_000), WD) // 线下
  await w.handleEvent(execInterruptedEvent("s1"), WD) // Esc 与压缩无关（如纠正方向）
  await w.handleEvent(execSucceededEvent("s1"), WD) // 完结：peak 50k < 线，无事
  assert.equal(f.compacts.length, 0)
  await w.handleEvent(stepEvent("s1", 160_000), WD) // 之后过线 → 取消语义拦下
  assert.equal(f.compacts.length, 0)
  assert.ok(f.probes.some((p) => p.t === "trigger" && p.outcome === "skip-cancelled"))
  assert.equal(f.logs.filter((l) => l.includes("用户中断")).length, 1)
  await w.handleEvent(stepEvent("s1", 170_000), WD) // 滞回：不再重复说明
  assert.equal(f.logs.filter((l) => l.includes("用户中断")).length, 1)
})

// ---------- 摘要落盘（compaction.ended 事件路 + hook 产出路共用去重） ----------

const endedEvent = (sessionID: string, text: string) => ({
  type: "session.compaction.ended",
  data: { sessionID, text },
})

test("compaction.ended：摘要 trim 后落盘 tmpdir + 路径日志", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(endedEvent("s1", "  ## 项目一句话\n交接正文  "), WD)
  assert.equal(f.writes.length, 1)
  assert.ok(f.writes[0]!.path.startsWith(join("T", "mp")))
  assert.ok(f.writes[0]!.path.endsWith("opencode-handoff-s1.md"))
  assert.equal(f.writes[0]!.data, "## 项目一句话\n交接正文")
  assert.equal(f.logs.length, 1)
  assert.ok(f.logs[0]!.includes("opencode-handoff-s1.md"))
})

test("persisted 防双落盘：hook 产出路 + ended 事件路 + 事件重放，单会话只写一份", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.persistSummary("s1", "摘要 A") // hook 产出路径
  await w.handleEvent(endedEvent("s1", "摘要 A"), WD) // ended 事件路径
  await w.handleEvent(endedEvent("s1", "摘要 A"), WD) // 事件重放
  await w.persistSummary("s1", "摘要 A") // hook 重放
  assert.equal(f.writes.length, 1)
  await w.handleEvent(endedEvent("s2", "摘要 B"), WD) // 另一会话照常
  assert.equal(f.writes.length, 2)
})

test("同会话再压缩产出新摘要 → 覆盖写；同摘要重放仍去重（冒烟实测发现的缺陷）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(endedEvent("s1", "第一版摘要"), WD)
  await w.handleEvent(endedEvent("s1", "第一版摘要"), WD) // 同摘要重放 → dedup
  await w.handleEvent(endedEvent("s1", "第二版摘要"), WD) // 再压缩新摘要 → 覆盖写
  await w.handleEvent(endedEvent("s1", "第二版摘要"), WD) // 重放 → dedup
  assert.equal(f.writes.length, 2)
  assert.equal(f.writes[1]!.data, "第二版摘要")
  assert.deepEqual(
    f.probes.filter((p) => p.t === "persist").map((p) => p.outcome),
    ["wrote", "dedup", "wrote", "dedup"],
  )
})

test("落盘失败不标记 persisted → 修复后下个事件重试成功；错误向上抛（调用方降级）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  const orig = f.io.writeFile
  let broken = true
  f.io.writeFile = async (path, data) => {
    if (broken) throw new Error("disk full")
    await orig.call(f.io, path, data)
  }
  await assert.doesNotReject(w.handleEvent(endedEvent("s1", "摘要"), WD)) // 事件路：静默降级
  await assert.rejects(w.persistSummary("s1", "摘要")) // hook 路：向上抛，由接线层降级文案
  assert.equal(f.writes.length, 0)
  broken = false
  await w.handleEvent(endedEvent("s1", "摘要"), WD) // 未标记 → 重试成功
  assert.equal(f.writes.length, 1)
})

test("ended 载荷缺 sessionID / 缺 text / 纯空白 → 不落盘不日志；persistSummary 空参同样 no-op", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent({ type: "session.compaction.ended", data: { text: "x" } }, WD)
  await w.handleEvent({ type: "session.compaction.ended", data: { sessionID: "s1" } }, WD)
  await w.handleEvent(endedEvent("s1", "   "), WD)
  await w.persistSummary("", "x")
  await w.persistSummary("s1", "")
  assert.equal(f.writes.length, 0)
  assert.equal(f.logs.length, 0)
})

test("事件面绝不抛错：null / 垃圾载荷 / 未知类型 / started 无载荷一律静默", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await assert.doesNotReject(w.handleEvent(null, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.compaction.ended" }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.compaction.started", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.compaction.failed", data: null }, WD))
  await assert.doesNotReject(w.handleEvent(undefined, WD))
  await assert.doesNotReject(w.handleEvent({ type: "something.else", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.usage.updated", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.step.ended", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.created", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.execution.started", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.execution.succeeded", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.execution.interrupted", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.retry.scheduled", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "shell.created", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "shell.created", data: { info: null } }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "shell.exited", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.shell.started", data: null }, WD))
  await assert.doesNotReject(w.handleEvent({ type: "session.shell.ended", data: null }, WD))
  assert.equal(f.writes.length, 0)
  assert.equal(f.logs.length, 0)
})

// ---------- 探针（HANDOFF_COMPACTION_PROBE=1 冒烟诊断；逻辑层经 IO 注入，可测） ----------

test("探针：step 事件记录形状与决策（sid/used/peak/line/fire），未知类型也记 type", async () => {
  const f = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON() })
  const w = new Watcher(f.io)
  await w.handleEvent(stepEvent("s1", 50_000), WD) // 线下
  await w.handleEvent(stepEvent("s1", 120_000), WD) // 过线（90k 档位线）→ 发起
  await w.handleEvent({ type: "something.else", data: {} }, WD) // 总线上的未知事件
  const steps = f.probes.filter((p) => p.t === "event" && p.type === "session.step.ended")
  assert.equal(steps.length, 2)
  assert.deepEqual(
    { ...steps[1] },
    {
      t: "event",
      type: "session.step.ended",
      sid: "s1",
      used: 120_000,
      peak: 120_000,
      line: 90_000,
      fire: true,
      dataKeys: ["sessionID", "assistantMessageID", "finish", "tokens"],
      tokKeys: ["input", "output", "reasoning", "cache"],
    },
  )
  assert.equal(steps[0]!.fire, false)
  assert.ok(f.probes.some((p) => p.t === "event" && p.type === "something.else")) // 冒烟时看总线上到底来什么事件
})

test("探针：阈值盘读记一条（value + source + matched），缓存命中不再记；降级记 default", async () => {
  const ok = fakeIO({ [join(WD, ".opencode", "models.json")]: modelsJSON() })
  const w1 = new Watcher(ok.io)
  await w1.handleEvent(stepEvent("s1", 50_000), WD)
  await w1.handleEvent(stepEvent("s1", 60_000), WD)
  const disk = ok.probes.filter((p) => p.t === "threshold")
  assert.equal(disk.length, 1) // 第二个事件走缓存，不重复记
  assert.deepEqual({ ...disk[0] }, { t: "threshold", cwd: WD, sid: "s1", value: 90_000, source: "project", matched: "active" })
  const miss = fakeIO()
  const w2 = new Watcher(miss.io)
  await w2.handleEvent(stepEvent("s1", 50_000), WD)
  assert.deepEqual(
    { ...miss.probes.find((p) => p.t === "threshold") },
    { t: "threshold", cwd: WD, sid: "s1", value: DEFAULT_SMART_ZONE, source: "default" },
  )
})

test("探针：落盘结局 wrote / dedup / fail 可分辨", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(endedEvent("s1", "摘要"), WD)
  await w.handleEvent(endedEvent("s1", "摘要"), WD) // 重放 → dedup
  const orig = f.io.writeFile
  f.io.writeFile = async () => {
    throw new Error("disk full")
  }
  await w.handleEvent(endedEvent("s2", "摘要"), WD) // 写失败 → fail
  f.io.writeFile = orig
  const persist = f.probes.filter((p) => p.t === "persist")
  assert.equal(persist.length, 3)
  assert.deepEqual({ ...persist[0] }, { t: "persist", sid: "s1", outcome: "wrote", path: join("T", "mp", "opencode-handoff-s1.md") })
  assert.deepEqual({ ...persist[1] }, { t: "persist", sid: "s1", outcome: "dedup" })
  assert.equal(persist[2]!.outcome, "fail")
  assert.ok(String(persist[2]!.error).includes("disk full"))
})

test("探针：compaction.ended 事件记 textLen（载荷形状冒烟证据）", async () => {
  const f = fakeIO()
  const w = new Watcher(f.io)
  await w.handleEvent(endedEvent("s1", "六段摘要"), WD)
  const ev = f.probes.find((p) => p.t === "event" && p.type === "session.compaction.ended")
  assert.deepEqual({ ...ev }, { t: "event", type: "session.compaction.ended", sid: "s1", textLen: 4, dataKeys: ["sessionID", "text"] })
})
