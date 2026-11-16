// auto-handoff 纯逻辑层直测（node --test，零依赖零平台耦合——IO/ctx 注入）
// 覆盖面：六段模板结构锁、转录压缩（capText/toolLine/transcriptOf）、agent 清单
//   （listAgentNames，v0.27）、title 契约（relayTitle「接力 @」前缀 + 简述）、
//   最小指针包、降级裁剪（trimMessagesBefore）、结果文案（handoffResult）、
//   薄交接引擎（makeHandoff：generate 面/空消息/去模型化无 model 键；handoffToFresh：
//   主链参数形状/引擎降级/create 形态/synthetic 不阻断/任务下发失败带警示/缺 prompt 面
//   带警示；v0.28 create 落 metadata 链路），以及 tui 半纯函数（isRelaySession/
//   latestRelaySession/followSession/listSessions/relayChain 走链——tui-core.ts）。
// v0.27 去模型化轮：readModelsDoc/resolveWorkerModel/splitModel 及 models.json 夹具随产线退役。
// v0.28 接力链轮：RELAY_PARENT_META 双半契约锁 + relayChain（线性/分叉/断链/环/
//   旧版无链数据/子代理继承噪声滤除）。
// v0.29 岗位模型轮：modelRefOf/modelRefLabel/agentModelOf/modelExists 直测 +
//   handoffToFresh 模型主链（create 携 model/岗无模型零变化/不在册不落/带模型失败
//   去模型重试/重试再败上抛/校验面不可用照常落/注记与警示合并）。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  agentModelOf,
  capText,
  HANDOFF_TEMPLATE,
  handoffResult,
  handoffToFresh,
  listAgentNames,
  makeHandoff,
  minimalHandoff,
  modelExists,
  modelRefLabel,
  modelRefOf,
  obj,
  RELAY_PARENT_META,
  relayTitle,
  str,
  toolLine,
  transcriptOf,
  TRANSCRIPT_MARKER,
  trimMessagesBefore,
  type CoreIO,
  type HandoffHost,
  type ModelRef,
} from "./handoff-core.ts"
import {
  followSession,
  isRelaySession,
  latestRelaySession,
  listSessions,
  MAX_CHAIN_HOPS,
  relayChain,
  relayParentOf,
  RELAY_TITLE_PREFIX,
  type RelayChainRow,
  type TuiHost,
  RELAY_PARENT_META as TUI_RELAY_PARENT_META,
} from "./tui-core.ts"

// ---------- 注入伪造 ----------

/** v0.27 去模型化后逻辑层 IO 只剩日志（fs 面随 models.json 退役） */
function fakeLog() {
  const logs: string[] = []
  const io: CoreIO = {
    log(message) {
      logs.push(message)
    },
  }
  return { io, logs }
}

/** 接力 ctx 伪造：agent/model/session 域 + generate 面，全调用留痕（v0.29：agent 清单
 *  携岗模型、model 清单做存在性校验、createImpl 可按入参注入失败——带模型 create 的
 *  重试路径用）；agentListResult/modelListResult 键缺席 = 域面缺席（旧宿主形态）。 */
function relayCtx(opts: {
  contextResult?: unknown
  generateImpl?: (args: Record<string, unknown>) => Promise<{ text: string }>
  createResult?: unknown
  createImpl?: (args: Record<string, unknown>) => Promise<unknown>
  syntheticImpl?: (args: Record<string, unknown>) => Promise<void>
  promptImpl?: (args: Record<string, unknown>) => Promise<void>
  noPromptFace?: boolean
  agentListResult?: unknown
  modelListResult?: unknown
} = {}) {
  const calls = { context: [] as unknown[], generate: [] as unknown[], create: [] as unknown[], synthetic: [] as unknown[], prompt: [] as unknown[] }
  const ctx: HandoffHost = {
    ...("agentListResult" in opts ? { agent: { list: async () => opts.agentListResult } } : {}),
    ...("modelListResult" in opts ? { model: { list: async () => opts.modelListResult } } : {}),
    session: {
      context: async (a) => {
        calls.context.push(a)
        return opts.contextResult ?? []
      },
      create: async (a) => {
        calls.create.push(a)
        if (opts.createImpl) return opts.createImpl(a)
        return opts.createResult ?? { id: "ses_new" }
      },
      synthetic: async (a) => {
        calls.synthetic.push(a)
        await opts.syntheticImpl?.(a)
      },
      ...(opts.noPromptFace
        ? {}
        : {
            prompt: async (a) => {
              calls.prompt.push(a)
              await opts.promptImpl?.(a)
            },
          }),
    },
  }
  const impl = opts.generateImpl
  if (impl) {
    ctx.experimental = {
      generate: {
        text: async (a) => {
          calls.generate.push(a)
          return impl(a)
        },
      },
    }
  }
  return { ctx, calls }
}

const gen = (text: string) => async () => ({ text })

// ---------- HANDOFF_TEMPLATE 结构锁（本件自有契约，见 handoff-core.ts 模板注） ----------

test("HANDOFF_TEMPLATE 六段二级标题按序 + Matt 原版规则句 + 界桩独立导出", () => {
  const sections = [...HANDOFF_TEMPLATE.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(sections, ["Project one-liner", "Current state", "Key decisions from the conversation", "Environment gotchas", "Artifact map", "Suggested skills"])
  // Matt handoff skill 原句（v0.26 原版轮；脱敏句按仓库机械红线删一词，语义不变）
  assert.ok(HANDOFF_TEMPLATE.includes("Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead."))
  assert.ok(HANDOFF_TEMPLATE.includes("Redact sensitive information, such as API keys, passwords, or personally identifiable information."))
  assert.ok(HANDOFF_TEMPLATE.includes("call the Skill tool for")) // suggested skills 段原句
  assert.equal(TRANSCRIPT_MARKER, "=== Conversation transcript (possibly truncated) ===\n") // 界桩：拼装处插焦点行之后
  assert.ok(!HANDOFF_TEMPLATE.includes("=== Conversation transcript")) // 界桩不在模板内（拼 prompt 时插入）
})

// ---------- capText ----------

test("capText 短串原样返回（引用相等）；超限头 15% + 尾 85% + 截断标记", () => {
  const s = "短串"
  assert.equal(capText(s), s)
  assert.equal(capText(s, 10), s) // 自定义上限同样短路
  const head = "H".repeat(3) // floor(20*0.15)
  const tail = "T".repeat(17)
  const out = capText(head + "M".repeat(10) + tail, 20)
  assert.equal(out, head + "\n…(middle truncated)…\n" + tail)
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
})

// ---------- transcriptOf ----------

test("transcriptOf 顶层 text 优先；parts / content 兜底；文本与工具行混合；空消息跳过", () => {
  const msgs = [
    { type: "user", text: "  帮我接力  " },
    { type: "assistant", parts: [{ type: "text", text: "正在处理" }, { type: "tool", name: "skill", state: { input: { id: "tdd" }, status: "completed" } }] },
    { type: "assistant", content: [{ type: "text", text: "content 形态" }] },
    { type: "user", parts: [{ type: "text", text: "   " }] }, // 纯空白 → 跳过
  ]
  assert.equal(
    transcriptOf(msgs),
    "[user] 帮我接力\n\n[assistant] 正在处理\n[tool skill] {\"id\":\"tdd\"}\n\n[assistant] content 形态",
  )
})

test("transcriptOf 类型缺失记 [?]；空输入 / null 安全返回空串", () => {
  assert.equal(transcriptOf([{ text: "无类型" }]), "[?] 无类型")
  assert.equal(transcriptOf([]), "")
  assert.equal(transcriptOf(undefined), "")
})

// ---------- minimalHandoff ----------

test("minimalHandoff 三行指针：岗位、原会话、原始需求；空需求回落指引", () => {
  const out = minimalHandoff("ses_old", "build", "做 spec")
  assert.ok(out.includes("@build"))
  assert.ok(out.includes("ses_old"))
  assert.ok(out.includes("做 spec"))
  assert.ok(minimalHandoff("s", "build", "").includes("（见下一条任务消息）"))
})

// ---------- trimMessagesBefore（降级链 context hook 保底） ----------

test("trimMessagesBefore 未命中 / bound 是首条 → 原数组原样返回（引用相等）", () => {
  const msgs = [{ id: "a" }, { id: "b" }, { id: "c" }]
  assert.equal(trimMessagesBefore(msgs, "nope"), msgs)
  assert.equal(trimMessagesBefore(msgs, "a"), msgs)
})

test("trimMessagesBefore 命中 → bound 之前全裁，替换单条边界提示（断而不失引导）", () => {
  const msgs = [{ id: "a" }, { id: "b" }, { id: "c" }]
  const out = trimMessagesBefore(msgs, "b")
  assert.equal(out.length, 3) // 提示 + b + c
  assert.equal(obj(out[0]).role, "user")
  assert.ok(str(obj(out[0]).content).includes("<context-boundary>"))
  assert.ok(str(obj(out[0]).content).includes("仓库工件"))
  assert.deepEqual(out.slice(1), [msgs[1], msgs[2]])
})

// ---------- handoffResult（0/2/3 文案契约） ----------

test("handoffResult 3 态附检查指引；空 reason 记「参数缺失」", () => {
  assert.equal(handoffResult(new Error("agent 不能为空"), 3, "build"), "handoff FAIL(3 用法错误)：agent 不能为空——检查参数后重试")
  assert.equal(handoffResult("", 3, "build"), "handoff FAIL(3 用法错误)：参数缺失——检查参数后重试")
})

test("handoffResult 2 态附手动切岗回退指引（含 agent）；空 reason 记「RPC 不可达」；非 Error 取 String", () => {
  assert.equal(handoffResult(new Error("down"), 2, "build"), "handoff FAIL(2 环境不可用)：down——请用户手动切换到 @build 岗位并下发任务文本，同样等效")
  assert.equal(handoffResult(null, 2, "build"), "handoff FAIL(2 环境不可用)：RPC 不可达——请用户手动切换到 @build 岗位并下发任务文本，同样等效")
  assert.ok(handoffResult(42, 3, "build").includes("42"))
})

// ---------- listAgentNames（v0.27 前置校验面） ----------

test("listAgentNames 兼容 {data} 与裸数组；id/name 并入有效集且去重；空名条目滤除", async () => {
  const { io } = fakeLog()
  const data = { agent: { list: async () => ({ data: [{ id: "build", name: "build" }, { id: "general" }, { name: "计划" }, {}, { id: 42 }] }) } }
  assert.deepEqual(await listAgentNames(data, io), ["build", "general", "计划"])
  const bare = { agent: { list: async () => [{ id: "a" }] } }
  assert.deepEqual(await listAgentNames(bare, io), ["a"])
})

test("listAgentNames 空清单 / 域缺失 → undefined（不可校验，不误杀且不日志）", async () => {
  const { io, logs } = fakeLog()
  assert.equal(await listAgentNames({ agent: { list: async () => ({ data: [] }) } }, io), undefined)
  assert.equal(await listAgentNames({}, io), undefined)
  assert.equal(logs.length, 0)
})

test("listAgentNames 调用抛错 → undefined + 落日志（静默降级 ≠ 无声降级）", async () => {
  const { io, logs } = fakeLog()
  const boom = { agent: { list: async () => { throw new Error("rpc down") } } }
  assert.equal(await listAgentNames(boom, io), undefined)
  assert.equal(logs.length, 1)
  assert.ok(logs[0]!.includes("agent 清单不可读"))
  assert.ok(logs[0]!.includes("rpc down"))
})

// ---------- 岗位模型三件（v0.29：modelRefOf / modelRefLabel / agentModelOf / modelExists） ----------

test("modelRefOf 对象形态收窄：variant 缺席合法；缺 providerID/id / 非对象 → undefined；variant 空串视作缺席", () => {
  assert.deepEqual(modelRefOf({ id: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variant: "high" }), { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash", variant: "high" })
  assert.deepEqual(modelRefOf({ id: "m", providerID: "p" }), { providerID: "p", id: "m" })
  assert.equal(modelRefOf({ id: "m", variant: "high" }), undefined) // 缺 providerID
  assert.equal(modelRefOf({ providerID: "p", variant: "high" }), undefined) // 缺 id
  assert.equal(modelRefOf(undefined), undefined)
  assert.equal(modelRefOf("zhipuai-coding-plan/glm-5.3"), undefined) // 串形态不作解码（插件只吃宿主解码结果）
  assert.deepEqual(modelRefOf({ id: "m", providerID: "p", variant: "" }), { providerID: "p", id: "m" })
})

test("modelRefLabel：provider/model#variant；variant 缺席不加 #", () => {
  assert.equal(modelRefLabel({ providerID: "zhipuai-coding-plan", id: "glm-5.3-flash", variant: "high" }), "zhipuai-coding-plan/glm-5.3-flash#high")
  assert.equal(modelRefLabel({ providerID: "p", id: "m" }), "p/m")
})

test("agentModelOf 按 id 匹配取岗模型（name 撞车不作键）；岗无 model / 清单没该岗 / 域缺失 → undefined", async () => {
  const { io, logs } = fakeLog()
  const data = { agent: { list: async () => ({ data: [
    { id: "general", name: "别的岗", model: { id: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variant: "high" } },
    { id: "manager", name: "general", model: { id: "glm-5.3", providerID: "zhipuai-coding-plan" } }, // name 与上岗 id 撞车
    { id: "build" }, // 岗无 model
  ] }) } }
  const host = data as HandoffHost
  assert.deepEqual(await agentModelOf(host, io, "general"), { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash", variant: "high" })
  assert.deepEqual(await agentModelOf(host, io, "manager"), { providerID: "zhipuai-coding-plan", id: "glm-5.3" })
  assert.equal(await agentModelOf(host, io, "build"), undefined)
  assert.equal(await agentModelOf(host, io, "nope"), undefined)
  assert.equal(await agentModelOf({}, io, "build"), undefined) // 域缺失（旧宿主）静默
  assert.equal(logs.length, 0)
})

test("agentModelOf 调用抛错 → undefined + 落日志（静默降级 ≠ 无声降级）", async () => {
  const { io, logs } = fakeLog()
  const boom = { agent: { list: async () => { throw new Error("rpc down") } } }
  assert.equal(await agentModelOf(boom, io, "build"), undefined)
  assert.equal(logs.length, 1)
  assert.ok(logs[0]!.includes("岗位模型未应用"))
  assert.ok(logs[0]!.includes("rpc down"))
})

test("modelExists 三态：在册（含 variant）/ 明确不在册（provider、model、variant 各缺一路）/ 清单空 → undefined", async () => {
  const { io, logs } = fakeLog()
  const list = { model: { list: async () => ({ data: [
    { id: "glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variants: [{ id: "low" }, { id: "high" }] },
    { id: "glm-5.3", modelID: "glm-5.3", providerID: "zhipuai-coding-plan", variants: [] },
  ] }) } }
  const host = list as HandoffHost
  const flash: ModelRef = { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash", variant: "high" }
  assert.equal(await modelExists(host, io, flash), true)
  assert.equal(await modelExists(host, io, { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash", variant: "max" }), false) // variant 不在册
  assert.equal(await modelExists(host, io, { providerID: "zhipuai-coding-plan", id: "glm-5.3" }), true) // 无 variant + 空 variants 数组
  assert.equal(await modelExists(host, io, { providerID: "zhipuai-coding-plan", id: "nope" }), false) // 模型不在册
  assert.equal(await modelExists(host, io, { providerID: "nope", id: "glm-5.3" }), false) // provider 不在册
  const empty = { model: { list: async () => ({ data: [] }) } }
  assert.equal(await modelExists(empty as HandoffHost, io, flash), undefined) // 空清单 = 不可校验
  assert.equal(await modelExists({}, io, flash), undefined) // 域缺失（旧宿主）
  assert.equal(logs.length, 0)
})

test("modelExists 抛错 → undefined + 落日志；裸数组返回形态兼容", async () => {
  const { io, logs } = fakeLog()
  const boom = { model: { list: async () => { throw new Error("model rpc down") } } }
  assert.equal(await modelExists(boom as HandoffHost, io, { providerID: "p", id: "m" }), undefined)
  assert.equal(logs.length, 1)
  assert.ok(logs[0]!.includes("跳过岗位模型校验"))
  const bare = { model: { list: async () => [{ providerID: "p", modelID: "m" }] } }
  assert.equal(await modelExists(bare as HandoffHost, io, { providerID: "p", id: "m" }), true)
})

// ---------- relayTitle（两半唯一契约的前缀半 + 简述装饰） ----------

test("relayTitle：前缀「接力 @<agent>」；简述压平空白、超限截断带省略号；空 prompt 只剩前缀", () => {
  assert.equal(relayTitle("build", ""), "接力 @build")
  assert.equal(relayTitle("build", "   "), "接力 @build") // 纯空白等同空
  assert.equal(relayTitle("build", "  做 spec\n第二行  "), "接力 @build 做 spec 第二行")
  assert.equal(relayTitle("build", "任".repeat(50)), `接力 @build ${"任".repeat(40)}…`) // 默认 40 截断
  assert.equal(relayTitle("build", "short", 3), "接力 @build sho…") // 自定义上限
})

// ---------- makeHandoff（薄交接生成，v0.27 去模型化） ----------

test("makeHandoff 主路：generate 不带 model 键（宿主默认）+ 模板拼焦点与转录，摘要 trim 返回", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({ contextResult: [{ id: "m1", role: "user", text: "需求" }], generateImpl: gen("  handoff doc  ") })
  assert.equal(await makeHandoff(f.io, ctx, "ses_old", "@build：做 spec"), "handoff doc")
  assert.equal(calls.generate.length, 1)
  assert.ok(!("model" in obj(calls.generate[0]))) // v0.27：摘要模型归宿主默认，插件不指定
  const prompt = str(obj(calls.generate[0]).prompt)
  assert.ok(prompt.startsWith("You are a handoff generator"))
  const focusLine = "Relay focus (what the next session will be used for): @build：做 spec"
  assert.ok(prompt.includes(focusLine)) // Matt「按参数裁剪」：焦点进提示词
  assert.ok(prompt.indexOf(focusLine) < prompt.indexOf("=== Conversation transcript")) // 焦点在界桩之前（贴近转录吃 recency）
  assert.ok(prompt.endsWith("[user] 需求"))
  assert.ok(f.logs.some((l) => l.includes("离屏生成交接摘要")))
})

test("makeHandoff context 兼容 {messages} 包装形态", async () => {
  const f = fakeLog()
  const { ctx } = relayCtx({ contextResult: { messages: [{ id: "m1", text: "hi" }] }, generateImpl: gen("摘要") })
  assert.equal(await makeHandoff(f.io, ctx, "ses_old"), "摘要")
})

test("makeHandoff 各失败面：generate 缺 / 消息空 / 摘要空 → 抛错交调用方降级", async () => {
  const f = fakeLog()
  const noGen = relayCtx({ contextResult: [{ id: "m1", text: "hi" }] })
  await assert.rejects(makeHandoff(f.io, noGen.ctx, "s"), /generate 面不可用/)
  const empty = relayCtx({ contextResult: [], generateImpl: gen("x") })
  await assert.rejects(makeHandoff(f.io, empty.ctx, "s"), /原会话消息面为空/)
  const blank = relayCtx({ contextResult: [{ id: "m1", text: "hi" }], generateImpl: gen("   ") })
  await assert.rejects(makeHandoff(f.io, blank.ctx, "s"), /交接摘要为空/)
})

// ---------- handoffToFresh（E-final 主链，v0.27：create 落岗 + prompt 下发） ----------

test("handoffToFresh 主路（agent 面缺席 = 岗模型不可读）：create 携 {title, agent, metadata 链路} 无 model + synthetic 注摘要 + prompt 下发任务 + 无警示", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({ contextResult: [{ id: "m1", role: "user", text: "需求" }], generateImpl: gen("六段摘要") })
  const r = await handoffToFresh(f.io, ctx, "ses_old", "build", "做 spec")
  assert.deepEqual(r, { s2: "ses_new" }) // 无 model / warning 键——岗模型不可读时零变化（v0.29 边界）
  // tui.ts 靠此前缀导航（两半唯一契约）；无 model 键——该夹具无 agent 面，岗模型读不到
  // 即不落（岗有模型的形态见下方 v0.29 组）；metadata 记链路（relay.parent → 原会话）
  assert.deepEqual(calls.create, [{ title: "接力 @build 做 spec", agent: "build", metadata: { [RELAY_PARENT_META]: "ses_old" } }])
  assert.deepEqual(calls.synthetic, [{ sessionID: "ses_new", text: "六段摘要" }])
  assert.deepEqual(calls.prompt, [{ sessionID: "ses_new", text: "做 spec" }])
  assert.ok(str(obj(calls.generate[0]).prompt).includes("Relay focus (what the next session will be used for): @build：做 spec")) // 焦点透传（handoffToFresh 内拼 @岗位 + 任务）
  assert.ok(f.logs.some((l) => l.includes("接力完成")))
})

test("handoffToFresh 交接引擎失败 → 注最小指针包（不阻断主链），日志留降级证据", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({ contextResult: [] }) // makeHandoff 必败（消息面为空）
  const r = await handoffToFresh(f.io, ctx, "ses_old", "build", "原始需求")
  assert.equal(r.s2, "ses_new")
  const injected = str(obj(calls.synthetic[0]).text)
  assert.ok(injected.includes("ses_old") && injected.includes("@build") && injected.includes("原始需求"))
  assert.ok(f.logs.some((l) => l.includes("降级为最小指针包")))
})

test("handoffToFresh create 兼容裸字符串返回；无 id → 抛错（create 级失败交调用方降级）", async () => {
  const f = fakeLog()
  const bare = relayCtx({ contextResult: [], createResult: "ses_str" })
  assert.equal((await handoffToFresh(f.io, bare.ctx, "s", "build", "t")).s2, "ses_str")
  const noId = relayCtx({ contextResult: [], createResult: {} })
  await assert.rejects(handoffToFresh(f.io, noId.ctx, "s", "build", "t"), /create 未返回会话 id/)
})

test("handoffToFresh synthetic 失败不阻断：日志留证，prompt 照常，无警示", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({
    contextResult: [{ id: "m1", text: "hi" }],
    generateImpl: gen("摘要"),
    syntheticImpl: async () => { throw new Error("inject down") },
  })
  const r = await handoffToFresh(f.io, ctx, "s", "build", "t")
  assert.deepEqual(r, { s2: "ses_new" })
  assert.equal(calls.prompt.length, 1)
  assert.ok(f.logs.some((l) => l.includes("交接注入失败") && l.includes("inject down")))
})

test("handoffToFresh 任务下发失败 → 0 态带 ⚠ 警示（不上抛、不二次降级）", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({
    contextResult: [{ id: "m1", text: "hi" }],
    generateImpl: gen("摘要"),
    promptImpl: async () => { throw new Error("PromptRejected") },
  })
  const r = await handoffToFresh(f.io, ctx, "s", "build", "t")
  assert.equal(r.s2, "ses_new")
  assert.ok(r.warning!.includes("@build"))
  assert.ok(r.warning!.includes("PromptRejected"))
  assert.ok(r.warning!.includes("ses_new"))
  assert.equal(calls.synthetic.length, 1) // 交接已注入
  assert.ok(f.logs.some((l) => l.includes("按 0 态带警示返回")))
})

test("handoffToFresh 宿主无 prompt 面 → 同为 0 态带警示（缺面显式可见，不假装成功）", async () => {
  const f = fakeLog()
  const { ctx } = relayCtx({ contextResult: [{ id: "m1", text: "hi" }], generateImpl: gen("摘要"), noPromptFace: true })
  const r = await handoffToFresh(f.io, ctx, "s", "build", "t")
  assert.equal(r.s2, "ses_new")
  assert.ok(r.warning!.includes("宿主无 session.prompt 面"))
  assert.ok(f.logs.some((l) => l.includes("无 prompt 面")))
})

// ---------- handoffToFresh 岗位模型主链（v0.29：V2 primary 会话选岗不改模型，须显式落 create） ----------

/** v0.29 常用夹具：general 岗配 flash#high，model 清单在册 */
function modelCtx(extra: Parameters<typeof relayCtx>[0] = {}) {
  return relayCtx({
    contextResult: [{ id: "m1", role: "user", text: "需求" }],
    generateImpl: gen("六段摘要"),
    agentListResult: { data: [{ id: "general", name: "General", model: { id: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variant: "high" } }] },
    modelListResult: { data: [{ id: "glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variants: [{ id: "low" }, { id: "high" }] }] },
    ...extra,
  })
}

test("handoffToFresh 岗位模型主路：create 携 {title, agent, model, metadata} 一次建成，返回 model 展示串、无警示", async () => {
  const f = fakeLog()
  const { ctx, calls } = modelCtx()
  const r = await handoffToFresh(f.io, ctx, "ses_old", "general", "做 spec")
  assert.deepEqual(r, { s2: "ses_new", model: "zhipuai-coding-plan/glm-5.3-flash#high" })
  assert.deepEqual(calls.create, [{ title: "接力 @general 做 spec", agent: "general", model: { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash", variant: "high" }, metadata: { [RELAY_PARENT_META]: "ses_old" } }])
  assert.deepEqual(calls.prompt, [{ sessionID: "ses_new", text: "做 spec" }]) // 下发照常
  assert.ok(f.logs.some((l) => l.includes("岗位模型 zhipuai-coding-plan/glm-5.3-flash#high 已落会话")))
})

test("handoffToFresh 岗无 model（agent 面在、条目无 model 键）→ create 不带 model 键、返回无 model——与 v0.28 零变化", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({
    contextResult: [{ id: "m1", text: "hi" }],
    generateImpl: gen("摘要"),
    agentListResult: { data: [{ id: "build", name: "Build" }] }, // 岗无 model
    modelListResult: { data: [] },
  })
  const r = await handoffToFresh(f.io, ctx, "ses_old", "build", "t")
  assert.deepEqual(r, { s2: "ses_new" }) // 无 model / 无 warning
  assert.deepEqual(calls.create, [{ title: "接力 @build t", agent: "build", metadata: { [RELAY_PARENT_META]: "ses_old" } }])
})

test("handoffToFresh 岗位模型不在册 → 不落会话（验收 3：不中断），warning 注明沿用默认、返回无 model", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({
    contextResult: [{ id: "m1", text: "hi" }],
    generateImpl: gen("摘要"),
    agentListResult: { data: [{ id: "ghost", model: { id: "gone-model", providerID: "gone-provider" } }] },
    modelListResult: { data: [{ id: "glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variants: [] }] }, // gone 不在册
  })
  const r = await handoffToFresh(f.io, ctx, "s", "ghost", "t")
  assert.equal(r.s2, "ses_new")
  assert.equal("model" in r, false)
  assert.ok(r.warning!.includes("岗位模型 gone-provider/gone-model 不可用"))
  assert.ok(r.warning!.includes("沿用默认模型"))
  assert.ok(!("model" in obj(calls.create[0]))) // create 未携带 model
  assert.equal(calls.create.length, 1) // 无重试（本地已判不在册，非 create 失败）
  assert.ok(f.logs.some((l) => l.includes("不在宿主 model 清单")))
})

test("handoffToFresh 带模型 create 失败 → 去模型重试一次，接力不中断，warning 注明应用失败", async () => {
  const f = fakeLog()
  const { ctx, calls } = modelCtx({
    createImpl: async (a) => {
      if ("model" in a) throw new Error("model rejected")
      return { id: "ses_retry" }
    },
  })
  const r = await handoffToFresh(f.io, ctx, "s", "general", "t")
  assert.equal(r.s2, "ses_retry")
  assert.equal("model" in r, false)
  assert.ok(r.warning!.includes("岗位模型 zhipuai-coding-plan/glm-5.3-flash#high 应用失败（model rejected）"))
  assert.equal(calls.create.length, 2) // 先带模型、后去模型
  assert.ok("model" in obj(calls.create[0]))
  assert.ok(!("model" in obj(calls.create[1])))
  assert.deepEqual(calls.prompt, [{ sessionID: "ses_retry", text: "t" }])
  assert.ok(f.logs.some((l) => l.includes("去模型重试")))
})

test("handoffToFresh 带模型 create 失败且去模型重试再败 → 上抛交调用方降级（同会话切岗链）", async () => {
  const f = fakeLog()
  const { ctx, calls } = modelCtx({
    createImpl: async () => { throw new Error("create down") },
  })
  await assert.rejects(handoffToFresh(f.io, ctx, "s", "general", "t"), /create down/)
  assert.equal(calls.create.length, 2)
  assert.equal(calls.prompt.length, 0) // 未走到任务下发
})

test("handoffToFresh model 清单不可读（域缺失/空清单）→ 照常落模型（不误杀，坏了归 create 重试兜底）", async () => {
  const f = fakeLog()
  const { ctx, calls } = modelCtx({ modelListResult: { data: [] } }) // 空清单 = 不可校验
  const r = await handoffToFresh(f.io, ctx, "s", "general", "t")
  assert.equal(r.model, "zhipuai-coding-plan/glm-5.3-flash#high")
  assert.ok("model" in obj(calls.create[0]))
  assert.equal("warning" in r, false)
  // model 域整缺（旧宿主）：relayCtx 键缺席即域缺席，同样照常落
  const noFace = relayCtx({
    contextResult: [{ id: "m1", text: "hi" }],
    generateImpl: gen("摘要"),
    agentListResult: { data: [{ id: "general", model: { id: "glm-5.3-flash", providerID: "zhipuai-coding-plan", variant: "high" } }] },
  })
  const r2 = await handoffToFresh(f.io, noFace.ctx, "s", "general", "t")
  assert.equal(r2.model, "zhipuai-coding-plan/glm-5.3-flash#high")
})

test("handoffToFresh 模型不在册 + 任务下发失败 → 两类注记并入同一条 warning（不互相覆盖）", async () => {
  const f = fakeLog()
  const { ctx, calls } = relayCtx({
    contextResult: [{ id: "m1", text: "hi" }],
    generateImpl: gen("摘要"),
    agentListResult: { data: [{ id: "ghost", model: { id: "gone-model", providerID: "gone-provider" } }] },
    modelListResult: { data: [{ id: "other", modelID: "other", providerID: "p" }] }, // gone 不在册
    promptImpl: async () => { throw new Error("PromptRejected") },
  })
  const r = await handoffToFresh(f.io, ctx, "s", "ghost", "t")
  assert.ok(r.warning!.includes("岗位模型 gone-provider/gone-model 不可用"))
  assert.ok(r.warning!.includes("任务文本未能下发（PromptRejected）"))
  assert.ok(!("model" in obj(calls.create[0])))
})

// ---------- tui 半纯函数（零依赖直测；两半契约 = title 前缀「接力 @」） ----------

test("RELAY_TITLE_PREFIX 契约值 + isRelaySession 判据（title 前缀特征）", () => {
  assert.equal(RELAY_TITLE_PREFIX, "接力 @")
  assert.equal(isRelaySession({ title: "接力 @build 做 spec" }), true)
  assert.equal(isRelaySession({ title: "普通会话" }), false)
  assert.equal(isRelaySession({}), false)
  assert.equal(isRelaySession({ title: 42 }), false)
})

test("latestRelaySession 取 time.updated 最新；缺 updated 回落 created；并列取先者；无接力 → undefined", () => {
  assert.equal(latestRelaySession([]), undefined)
  assert.equal(latestRelaySession([{ title: "x" }, { title: "y" }]), undefined)
  const a = { id: "a", title: "接力 @1", time: { created: 5, updated: 2 } }
  const b = { id: "b", title: "接力 @2", time: { created: 1, updated: 9 } }
  assert.equal(latestRelaySession([a, b])!.id, "b")
  const c = { id: "c", title: "接力 @3", time: { created: 7 } } // 无 updated
  assert.equal(latestRelaySession([a, c])!.id, "c")
  const t1 = { id: "t1", title: "接力 @t", time: { updated: 5 } }
  const t2 = { id: "t2", title: "接力 @t", time: { updated: 5 } }
  assert.equal(latestRelaySession([t1, t2])!.id, "t1")
})

test("followSession tabs.focus 命中 → true 且不走 router", () => {
  let navigated = 0
  const ctx: TuiHost = { ui: { tabs: { focus: () => true }, router: { navigate: () => { navigated++ } } } }
  assert.equal(followSession(ctx, "s1"), true)
  assert.equal(navigated, 0)
})

test("followSession tabs 未命中/抛错 → router.navigate 兜底；navigate 缺失/抛错 → false", () => {
  let navigated: unknown = undefined
  const navCtx = (focus?: () => boolean): TuiHost => ({
    ui: {
      ...(focus ? { tabs: { focus } } : {}),
      router: { navigate: (a) => { navigated = a } },
    },
  })
  assert.equal(followSession(navCtx(() => false), "s1"), true) // 返回 false → 兜底
  assert.deepEqual(navigated, { type: "session", sessionID: "s1" })
  assert.equal(followSession(navCtx(() => { throw new Error("tabs down") }), "s2"), true) // 抛错 → 兜底
  assert.equal(followSession({ ui: {} }, "s3"), false) // 无 navigate
  assert.equal(followSession({ ui: { router: { navigate: () => { throw new Error("router down") } } } }, "s4"), false)
})

test("listSessions client（数组 / {data}）优先；client 空/抛错/缺失 → data store 兜底；双失效 → []", async () => {
  const arr = [{ id: "a" }]
  assert.deepEqual(await listSessions({ client: { session: { list: async () => arr } } }), arr)
  assert.deepEqual(await listSessions({ client: { session: { list: async () => ({ data: arr }) } } }), arr)
  const store = { data: { session: { list: () => arr } } }
  assert.deepEqual(await listSessions({ client: { session: { list: async () => [] } }, ...store }), arr) // client 空清单 → 兜底
  assert.deepEqual(await listSessions({ client: { session: { list: async () => { throw new Error("rpc") } } }, ...store }), arr)
  assert.deepEqual(await listSessions(store), arr) // 无 client
  assert.deepEqual(await listSessions({ data: { session: { list: () => { throw new Error("store") } } } }), [])
  assert.deepEqual(await listSessions({}), [])
})

// ---------- 接力链（v0.28：metadata 走链 + relayChain 纯函数） ----------

// 双半契约第二条：handoff-core.ts（server 半写入）与 tui-core.ts（TUI 半读取，顶部
// 以 TUI_RELAY_PARENT_META 引入）各持副本，值不一致 = 面板走不出链——测试锁死。
test("RELAY_PARENT_META 双半契约值一致（relay.parent）；RELAY_TITLE_PREFIX 契约值不变", () => {
  assert.equal(RELAY_PARENT_META, "relay.parent")
  assert.equal(TUI_RELAY_PARENT_META, RELAY_PARENT_META)
  assert.equal(RELAY_TITLE_PREFIX, "接力 @")
})

test("relayParentOf：metadata 正常/缺失/非串/非对象载荷收窄", () => {
  assert.equal(relayParentOf({ id: "b", metadata: { "relay.parent": "a" } }), "a")
  assert.equal(relayParentOf({ id: "b" }), "")
  assert.equal(relayParentOf({ metadata: {} }), "")
  assert.equal(relayParentOf({ metadata: { "relay.parent": 42 } }), "")
  assert.equal(relayParentOf({ metadata: "不是对象" }), "")
  assert.equal(relayParentOf(undefined), "")
})

/** 会话夹具：id + title（接力 @ 前缀 = handoff_to 建的）+ metadata 链路 + created 时间 */
function ses(id: string, opts: { relay?: boolean; parent?: string; created?: number; title?: string; extraMeta?: Record<string, unknown> } = {}) {
  const meta: Record<string, unknown> = { ...(opts.extraMeta ?? {}) }
  if (opts.parent !== undefined) meta[RELAY_PARENT_META] = opts.parent
  return {
    id,
    title: opts.title ?? (opts.relay ? `接力 @${id}` : `普通 ${id}`),
    ...(Object.keys(meta).length ? { metadata: meta } : {}),
    time: { created: opts.created ?? 0 },
  }
}

const ids = (rows: readonly RelayChainRow[]): string[] => rows.map((r) => r.session.id ?? "")

test("relayChain 线性链 A→B→C：B 视角 = 祖先 A + 当前 B + 后代 C，hop 连续、isCurrent 单命中", () => {
  const list = [ses("A", { created: 1 }), ses("B", { relay: true, parent: "A", created: 2 }), ses("C", { relay: true, parent: "B", created: 3 })]
  const chain = relayChain(list, "B")
  assert.deepEqual(ids(chain.rows), ["A", "B", "C"])
  assert.deepEqual(chain.rows.map((r) => r.hop), [1, 2, 3])
  assert.deepEqual(chain.rows.map((r) => r.isCurrent), [false, true, false])
  assert.equal(chain.legacy, false)
})

test("relayChain 起点视角只见后代（A 视角 A→B→C）；末端视角见全链（C 视角）", () => {
  const list = [ses("A", { created: 1 }), ses("B", { relay: true, parent: "A", created: 2 }), ses("C", { relay: true, parent: "B", created: 3 })]
  assert.deepEqual(ids(relayChain(list, "A").rows), ["A", "B", "C"])
  const fromC = relayChain(list, "C")
  assert.deepEqual(ids(fromC.rows), ["A", "B", "C"])
  assert.deepEqual(fromC.rows.map((r) => r.isCurrent), [false, false, true])
})

test("relayChain 分叉：同源多后代按 created 正序、深度优先展开", () => {
  const list = [
    ses("A", { created: 1 }),
    ses("B2", { relay: true, parent: "A", created: 3 }),
    ses("B1", { relay: true, parent: "A", created: 2 }),
    ses("C1", { relay: true, parent: "B1", created: 4 }),
  ]
  assert.deepEqual(ids(relayChain(list, "A").rows), ["A", "B1", "C1", "B2"])
})

test("relayChain 祖先已删除：断链处停，不虚构行；有 parent 链接不算 legacy", () => {
  const list = [ses("B", { relay: true, parent: "gone", created: 2 })]
  const chain = relayChain(list, "B")
  assert.deepEqual(ids(chain.rows), ["B"])
  assert.equal(chain.legacy, false) // 链接在（数据曾在），只是对端已删
})

test("relayChain 环（A→B→A）与自指（parent=自身）不死循环", () => {
  const ring = [ses("A", { created: 1 }), ses("B", { relay: true, parent: "A", created: 2 })]
  // 构造环：A 也带 relay.parent → B（手工脏数据）
  const dirty = [...ring, { ...ses("A2", { relay: true, parent: "B", created: 3 }), id: "A" }]
  const chain = relayChain(dirty, "A")
  assert.ok(chain.rows.length <= MAX_CHAIN_HOPS)
  assert.ok(new Set(ids(chain.rows)).size === ids(chain.rows).length) // 每会话至多一行
  const self = relayChain([ses("B", { relay: true, parent: "B", created: 1 })], "B")
  assert.deepEqual(ids(self.rows), ["B"])
})

test("relayChain 旧版接力会话（无 metadata）→ 仅自身 + legacy 标记；普通会话无链不标 legacy", () => {
  const legacy = relayChain([ses("B", { relay: true, created: 1 })], "B")
  assert.deepEqual(ids(legacy.rows), ["B"])
  assert.equal(legacy.legacy, true)
  const plain = relayChain([ses("A", { created: 1 })], "A")
  assert.deepEqual(ids(plain.rows), ["A"])
  assert.equal(plain.legacy, false)
})

test("relayChain 子代理继承 metadata 噪声不入链（title 判据）；当前会话不在清单 → 空链", () => {
  const list = [
    ses("A", { created: 1 }),
    ses("B", { relay: true, parent: "A", created: 2 }),
    // B 的子代理子会话：宿主继承 B 的 metadata（relay.parent=A）但 title 是任务描述
    ses("sub_1", { title: "Task: 调研", parent: "A", created: 3 }),
  ]
  // A 视角：后代只认接力 title——sub_1 不算
  assert.deepEqual(ids(relayChain(list, "A").rows), ["A", "B"])
  // sub_1 自身视角：非接力 title → 不上溯（继承的链接不当链走）
  const fromSub = relayChain(list, "sub_1")
  assert.deepEqual(ids(fromSub.rows), ["sub_1"])
  assert.equal(fromSub.legacy, false)
  // 不存在的会话
  assert.deepEqual(relayChain(list, "nope").rows, [])
})

test("relayChain 空入参安全：清单空 / sessionID 空", () => {
  assert.deepEqual(relayChain([], "x").rows, [])
  assert.deepEqual(relayChain([ses("A")], "").rows, [])
})

