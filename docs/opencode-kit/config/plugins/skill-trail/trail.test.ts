// skill-trail 纯逻辑层直测（node --test，零依赖零平台耦合）
// 覆盖面：三路信号合并幂等、transcript 回填（双形态 + mention 消费 + 窗口去重）、
//   水合合并去重、展示格式化。时间戳取本地整点，formatTrailLine 断言不受时区影响。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  applyActivated,
  applyToolAfter,
  applyToolBefore,
  applyTotalsDelta,
  capTotals,
  collectFromTranscript,
  createDeltaLedger,
  diffTotalsDelta,
  healTotals,
  extractTriggerContext,
  formatTrailLine,
  memberLabel,
  mergeRecords,
  PROMPT_SNIPPET_MAX,
  reconcileTranscript,
  renderReportHTML,
  sanitizeTotals,
  summarizeTrails,
  type SkillRecord,
  type TotalsMap,
} from "./trail.ts"

const T0 = new Date(2026, 0, 1, 10, 30, 0).getTime() // 本地 10:30，formatTrailLine 断言用
const ts = (offsetMs: number) => T0 + offsetMs

// ---------- applyToolBefore ----------

test("applyToolBefore 追加模型调用记录（callID + agent）", () => {
  const out = applyToolBefore([], { callID: "call_1", skillID: "review", agent: "build", ts: ts(0) })
  assert.deepEqual(out, [{ ts: ts(0), skillID: "review", agent: "build", trigger: "model", callID: "call_1" }])
})

test("applyToolBefore 同 callID 幂等（重放不重复追加）", () => {
  const first = applyToolBefore([], { callID: "call_1", skillID: "review", ts: ts(0) })
  const second = applyToolBefore(first, { callID: "call_1", skillID: "review", ts: ts(1) })
  assert.equal(second.length, 1)
  assert.equal(second[0]!.ts, ts(0)) // 保留首见时间戳
})

test("applyToolBefore 缺 skillID 原样返回（引用相等，零拷贝）", () => {
  const records: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model" }]
  assert.equal(applyToolBefore(records, { skillID: "", ts: ts(1) }), records)
})

// ---------- applyToolAfter ----------

test("applyToolAfter 按 callID 回填 status", () => {
  const records = applyToolBefore([], { callID: "call_1", skillID: "review", ts: ts(0) })
  const out = applyToolAfter(records, { callID: "call_1", skillID: "review", status: "error", ts: ts(500) })
  assert.equal(out[0]!.status, "error")
})

test("applyToolAfter 无 callID 时按 同id+无status+10s窗口 兜底匹配", () => {
  const records: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model" }]
  const out = applyToolAfter(records, { skillID: "review", status: "completed", ts: ts(9_000) })
  assert.equal(out[0]!.status, "completed")
})

test("applyToolAfter 窗口外 / 已有 status 不匹配，原样返回", () => {
  const stale: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model" }]
  assert.equal(applyToolAfter(stale, { skillID: "review", status: "completed", ts: ts(20_000) }), stale)
  const done: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", status: "completed" }]
  assert.equal(applyToolAfter(done, { skillID: "review", status: "error", ts: ts(1_000) }), done)
})

// ---------- applyActivated ----------

test("applyActivated 窗口内无名工具记录 → 补 name 不追加", () => {
  const records = applyToolBefore([], { callID: "call_1", skillID: "review", ts: ts(0) })
  const out = applyActivated(records, { skillID: "review", name: "Review", ts: ts(2_000) })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.name, "Review")
  assert.equal(out[0]!.trigger, "model")
})

test("applyActivated 无工具伴随 → 追加 user 记录；同 id+ts 重放幂等", () => {
  const first = applyActivated([], { skillID: "review", name: "Review", ts: ts(0) })
  assert.deepEqual(first, [{ ts: ts(0), skillID: "review", name: "Review", trigger: "user" }])
  const second = applyActivated(first, { skillID: "review", name: "Review", ts: ts(0) })
  assert.equal(second.length, 1)
})

// ---------- mergeRecords（水合：storage 旧史 × 内存增量） ----------

test("mergeRecords 不相交并集，按 ts 升序", () => {
  const stored: SkillRecord[] = [{ ts: ts(10_000), skillID: "b", trigger: "model", callID: "c2" }]
  const memory: SkillRecord[] = [{ ts: ts(0), skillID: "a", trigger: "user" }]
  assert.deepEqual(
    mergeRecords(stored, memory).map((r) => r.skillID),
    ["a", "b"],
  )
})

test("mergeRecords 同 callID 去重，保留信息更全者", () => {
  const stored: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1" }]
  const memory: SkillRecord[] = [
    { ts: ts(0), skillID: "review", trigger: "model", callID: "c1", status: "completed", name: "Review" },
  ]
  const out = mergeRecords(stored, memory)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.status, "completed")
  assert.equal(out[0]!.name, "Review")
})

test("mergeRecords 信息更全判定含 prompt（情境摘录参与打分）", () => {
  const stored: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1", name: "Review" }]
  const memory: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1", name: "Review", prompt: "帮我审查" }]
  assert.equal(mergeRecords(stored, memory)[0]!.prompt, "帮我审查")
})

test("mergeRecords 同 callID 同分取 b（内存增量更新鲜）", () => {
  const stored: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1", name: "Old" }]
  const memory: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1", name: "New" }]
  assert.equal(mergeRecords(stored, memory)[0]!.name, "New")
})

test("mergeRecords 无 callID 记录按 skillID+ts+trigger 精确去重", () => {
  const stored: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "user" }]
  const memory: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "user" }]
  assert.equal(mergeRecords(stored, memory).length, 1)
})

// ---------- collectFromTranscript ----------

function skillMessage(skillID: string, at: number, name?: string) {
  return { type: "skill", skill: skillID, name, text: "…", time: { created: at } }
}

function userMention(skillID: string, at: number) {
  return { type: "user", time: { created: at }, parts: [{ type: "text", text: `@${skillID}`, skills: [{ id: skillID, mention: true }] }] }
}

function toolPartMessage(skillID: string, at: number, opts?: { agent?: string; status?: string; name?: string }) {
  return {
    type: "assistant",
    agent: opts?.agent,
    time: { created: at },
    parts: [
      {
        type: "tool",
        name: "skill",
        state: { input: { id: skillID }, metadata: { name: opts?.name }, status: opts?.status },
        time: { created: at },
      },
    ],
  }
}

test("collectFromTranscript 专型消息 → 记录；激活前 @mention → user（一次性消费）", () => {
  const messages = [
    userMention("review", ts(0)),
    skillMessage("review", ts(1_000), "Review"),
    skillMessage("review", ts(60_000), "Review"), // 第二次激活无新 mention
  ]
  const out = collectFromTranscript(messages)
  assert.equal(out.length, 2)
  assert.equal(out[0]!.trigger, "user") // mention 命中并被消费
  assert.equal(out[1]!.trigger, "model") // mention 已耗尽
})

test("collectFromTranscript mention 晚于激活不回溯命中", () => {
  const messages = [skillMessage("review", ts(0)), userMention("review", ts(1_000))]
  assert.equal(collectFromTranscript(messages)[0]!.trigger, "model")
})

test("collectFromTranscript 工具部件路径（state.input.id / metadata.name / status / agent）", () => {
  const out = collectFromTranscript([toolPartMessage("review", ts(0), { agent: "build", status: "error", name: "Review" })])
  assert.deepEqual(out, [
    { ts: ts(0), skillID: "review", name: "Review", agent: "build", trigger: "model", status: "error" },
  ])
})

test("collectFromTranscript 双路径同 id 15s 窗口内去重（专型优先，保其 name）", () => {
  const messages = [
    skillMessage("review", ts(0), "Review"),
    toolPartMessage("review", ts(10_000), { name: "Review" }),
    toolPartMessage("review", ts(30_000)), // 窗口外，保留
  ]
  assert.equal(collectFromTranscript(messages).length, 2)
})

test("collectFromTranscript 容忍 content 数组形态 + 按 ts 排序输出", () => {
  const viaContent = {
    type: "assistant",
    time: { created: ts(10_000) },
    content: [
      { type: "tool", name: "skill", state: { input: { id: "b" }, metadata: {}, status: "completed" }, time: { created: ts(10_000) } },
    ],
  }
  const out = collectFromTranscript([viaContent, skillMessage("a", ts(0))])
  assert.deepEqual(out.map((r) => r.skillID), ["a", "b"])
})

test("collectFromTranscript 回填触发情境（激活前最近用户消息，每条记录独立摘录）", () => {
  const messages = [
    { type: "user", time: { created: ts(0) }, text: "帮我看看这个插件是做什么的" },
    skillMessage("review", ts(1_000), "Review"),
    { type: "user", time: { created: ts(60_000) }, text: "再帮我 review 一遍侧栏" },
    toolPartMessage("review", ts(61_000), { name: "Review" }),
  ]
  const out = collectFromTranscript(messages)
  assert.equal(out.length, 2)
  assert.equal(out[0]!.prompt, "帮我看看这个插件是做什么的")
  assert.equal(out[1]!.prompt, "再帮我 review 一遍侧栏")
})

// ---------- 2.2.5 真实形态回归锁（2026-11-03 opencode.db session_message 实证取证） ----------
// 当天 transcript 实测：tool part = {type:"tool", id:"call_…", name:"skill", executed:false,
// state:{input:{id}, status}}——callID 在 part 级 id；工具名在 name 键（非旧 tool 键）；
// metadata 可缺席；消息级 content 数组 + agent 字段。锁死 collectFromTranscript 兼容面
// （宿主升级后此节先红：形状又变了，别等用户报「又失效」）。

test("2.2.5 真实形态：content 数组 + part 级 callID/name 键/executed 冗余键，全链照采", () => {
  const messages = [
    {
      type: "assistant",
      agent: "luna-reviewer",
      time: { created: ts(0) },
      content: [
        { type: "text", text: "调 skill 审查" },
        { type: "tool", id: "call_f7d1", name: "skill", executed: false, state: { input: { id: "code-review" }, status: "completed" }, time: { created: ts(0) } },
      ],
    },
  ]
  assert.deepEqual(collectFromTranscript(messages), [
    { ts: ts(0), skillID: "code-review", name: undefined, agent: "luna-reviewer", trigger: "model", status: "completed" },
  ])
})

// ---------- 2.2.5 真实形态回归锁 II:内联 mention(2026-11-03 本会话二次取证) ----------
// 当天二次实测:用户 @mention 不再产生 type:"skill" 专型消息,而是内联进用户消息——
// 顶层 skills[] 数组带 {id,name,text,mention:{start,end,text}};且 session.skill.activated
// 对该流程不发射(host 二进制实证:该事件的持久化投影=追加专型消息,而实测 transcript 0 条)。
// 故 mention 必须自身成账,否则用户手动调用从轨迹里消失(仅剩模型工具路)。

function inlineMentionMessage(skillID: string, at: number, text = `@${skillID} `) {
  return {
    type: "user",
    time: { created: at },
    text,
    files: [],
    agents: [],
    skills: [{
      id: skillID,
      name: skillID,
      text: "<skill_content>…",
      mention: { start: 0, end: skillID.length + 1, text: `@${skillID}` },
    }],
  }
}

test("2.2.5 内联 mention（无专型消息）→ 自身成 user 记录，带 name 与情境摘录", () => {
  const messages = [
    inlineMentionMessage("use-pinpoint", ts(0)),
    toolPartMessage("pinpoint", ts(36_000), { name: "pinpoint" }), // 另一 skill 的模型调用，互不干扰
  ]
  const out = collectFromTranscript(messages)
  const mentionRecords = out.filter((r) => r.skillID === "use-pinpoint")
  assert.equal(mentionRecords.length, 1)
  assert.equal(mentionRecords[0]!.trigger, "user")
  assert.equal(mentionRecords[0]!.name, "use-pinpoint")
  assert.equal(mentionRecords[0]!.prompt, "@use-pinpoint")
})

test("2.2.5 mention 后同 id 工具调用 → 单条 user 记录（消费不双计，状态保留）", () => {
  const messages = [
    inlineMentionMessage("pinpoint", ts(0)),
    toolPartMessage("pinpoint", ts(36_000), { status: "completed" }),
  ]
  const out = collectFromTranscript(messages)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.trigger, "user")
  assert.equal(out[0]!.status, "completed")
})

test("2.2.5 工具调用先于 mention → 两次独立激活（model + user 各一条）", () => {
  const messages = [
    toolPartMessage("review", ts(0), { status: "completed" }),
    inlineMentionMessage("review", ts(60_000)),
  ]
  const out = collectFromTranscript(messages)
  assert.equal(out.length, 2)
  assert.equal(out[0]!.trigger, "model")
  assert.equal(out[1]!.trigger, "user")
})

test("双路径去重窗口边界：15s 内（14_999）去重、15s 外（15_001）独立记录", () => {
  const inWindow = [skillMessage("review", ts(0), "Review"), toolPartMessage("review", ts(14_999), { name: "Review" })]
  assert.equal(collectFromTranscript(inWindow).length, 1)
  const outOfWindow = [skillMessage("review", ts(0), "Review"), toolPartMessage("review", ts(15_001), { name: "Review" })]
  assert.equal(collectFromTranscript(outOfWindow).length, 2)
})

test("applyActivated 补名窗口边界：10s 整（10_000）补名、10s 外（10_001）另立 user 记录", () => {
  const records = applyToolBefore([], { callID: "c1", skillID: "review", ts: ts(0) })
  assert.equal(applyActivated(records, { skillID: "review", name: "Review", ts: ts(10_000) }).length, 1)
  const late = applyActivated(records, { skillID: "review", name: "Review", ts: ts(10_001) })
  assert.equal(late.length, 2)
  assert.equal(late[1]!.trigger, "user")
})

// ---------- reconcileTranscript（server 持久层 × transcript 对账） ----------
// 背景（2026-11-03 二进制定界）：session.skill.activated 仅由已 @deprecated 的
// session.skill 显式装载 API 发射，2.2.5 桌面流程（@mention 内联进 prompt 载荷）
// 整体绕开 → server 持久层对用户 @mention 零采集。补盲路 = 回合结束扫 transcript，
// 与事件账对账后入库。对账规则见 reconcileTranscript 头注。

test("reconcileTranscript 纯 @mention 记录入库（server 持久层补盲主路径）", () => {
  const transcript = collectFromTranscript([inlineMentionMessage("use-pinpoint", ts(0))])
  const out = reconcileTranscript([], transcript)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.skillID, "use-pinpoint")
  assert.equal(out[0]!.trigger, "user")
  assert.equal(out[0]!.name, "use-pinpoint")
})

test("reconcileTranscript transcript 工具记录窗口命中事件记录 → 合并不双计，补 name/status/prompt", () => {
  const stored = applyToolBefore([], { callID: "call_1", skillID: "review", agent: "build", ts: ts(1_000) })
  const transcript = collectFromTranscript([
    { type: "user", time: { created: ts(0) }, text: "帮我审查登录页" },
    toolPartMessage("review", ts(1_500), { name: "Review", status: "completed" }),
  ])
  const out = reconcileTranscript(stored, transcript)
  assert.equal(out.length, 1) // 窗口内同一次激活，事件侧胜，不追加
  assert.equal(out[0]!.callID, "call_1")
  assert.equal(out[0]!.agent, "build")
  assert.equal(out[0]!.ts, ts(1_000)) // 事件时间戳稳定（重扫幂等基）
  assert.equal(out[0]!.name, "Review") // transcript 补缺
  assert.equal(out[0]!.status, "completed")
  assert.equal(out[0]!.prompt, "帮我审查登录页")
  assert.equal(out[0]!.trigger, "model") // 无 mention → 不翻转
})

test("reconcileTranscript mention 后模型调用 → 事件记录翻转 user（与 TUI 口径一致）", () => {
  const stored = applyToolBefore([], { callID: "call_1", skillID: "pinpoint", ts: ts(36_000) })
  const transcript = collectFromTranscript([
    inlineMentionMessage("pinpoint", ts(0)),
    toolPartMessage("pinpoint", ts(36_500), { status: "completed" }), // mention 已被消费 → user
  ])
  const out = reconcileTranscript(stored, transcript)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.callID, "call_1")
  assert.equal(out[0]!.trigger, "user") // model→user 升格,不双计
  assert.equal(out[0]!.status, "completed")
})

test("reconcileTranscript 幂等：同 transcript 重扫输出稳定（精确键 + 窗口认领均不重复）", () => {
  const stored0 = applyToolBefore([], { callID: "call_1", skillID: "pinpoint", ts: ts(36_000) })
  const messages = [
    inlineMentionMessage("use-pinpoint", ts(0)),
    inlineMentionMessage("pinpoint", ts(0)),
    toolPartMessage("pinpoint", ts(36_500), { status: "completed", name: "pinpoint" }),
  ]
  const once = reconcileTranscript(stored0, collectFromTranscript(messages))
  const twice = reconcileTranscript(once, collectFromTranscript(messages))
  assert.deepEqual(twice, once)
})

test("reconcileTranscript 事件孤儿保留（transcript 已无对应,如 revert 撤回）", () => {
  const stored = applyToolBefore([], { callID: "call_1", skillID: "review", ts: ts(0) })
  const out = reconcileTranscript(stored, collectFromTranscript([inlineMentionMessage("other", ts(1_000))]))
  assert.equal(out.length, 2)
  assert.equal(out[0]!.callID, "call_1") // 事件记录不清账
  assert.equal(out[1]!.skillID, "other") // 新 mention 入账
})

test("reconcileTranscript 窗口边界：10s 内（10_000）命中合并、10s 外（10_001）独立成账", () => {
  const stored = applyToolBefore([], { callID: "c1", skillID: "review", ts: ts(0) })
  const inWindow = reconcileTranscript(stored, collectFromTranscript([toolPartMessage("review", ts(10_000))]))
  assert.equal(inWindow.length, 1)
  const outOfWindow = reconcileTranscript(stored, collectFromTranscript([toolPartMessage("review", ts(10_001))]))
  assert.equal(outOfWindow.length, 2)
})

// ---------- mention 回合边界（对账收敛前提：transcript 视图不得回溯变化） ----------
// 无界消费的病：1 月 mention 被跨回合的 3 月工具调用回溯消费 → transcript 视图事后
// 变化（mention 行消失、user 记录搬家到 3 月）→ server 对账无法跟踪回撤（双计/分叉）。
// 收窄为回合内消费（mention 与激活之间无新用户消息），跨回合各自成账、视图单调。

test("mention 跨回合不被后续工具调用消费 → 各自成账（user 兜底 + model）", () => {
  const messages = [
    inlineMentionMessage("pinpoint", ts(0)),
    { type: "user", time: { created: ts(60_000) }, text: "下一轮请求" },
    toolPartMessage("pinpoint", ts(120_000), { status: "completed" }),
  ]
  const out = collectFromTranscript(messages)
  assert.equal(out.length, 2)
  assert.equal(out[0]!.trigger, "user") // 上回合 mention 自身成账
  assert.equal(out[0]!.ts, ts(0))
  assert.equal(out[1]!.trigger, "model") // 本回合工具调用独立
  assert.equal(out[1]!.ts, ts(120_000))
})

test("mention 同回合长间隔照常消费（36s,回归锁既有语义）", () => {
  const messages = [
    inlineMentionMessage("pinpoint", ts(0)),
    toolPartMessage("pinpoint", ts(36_000), { status: "completed" }),
  ]
  const out = collectFromTranscript(messages)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.trigger, "user")
  assert.equal(out[0]!.status, "completed")
})

test("对账收敛（跨回合全链）：回合1 mention 入账 → 回合2 同 skill 工具调用不吞并不双计", () => {
  const sweep1 = reconcileTranscript([], collectFromTranscript([inlineMentionMessage("pinpoint", ts(0))]))
  const turn2 = [
    inlineMentionMessage("pinpoint", ts(0)),
    { type: "user", time: { created: ts(60_000) }, text: "下一轮请求" },
    toolPartMessage("pinpoint", ts(120_000), { status: "completed" }),
  ]
  const stored2 = applyToolBefore(sweep1, { callID: "c1", skillID: "pinpoint", ts: ts(120_000) })
  const sweep2 = reconcileTranscript(stored2, collectFromTranscript(turn2))
  assert.equal(sweep2.length, 2) // 与 transcript 视图一致：user@0 + model@120s
  assert.equal(sweep2[0]!.trigger, "user")
  assert.equal(sweep2[0]!.ts, ts(0))
  assert.equal(sweep2[1]!.callID, "c1")
  assert.equal(sweep2[1]!.trigger, "model") // 跨回合工具调用不翻转
  // 幂等：再扫一遍稳定
  assert.deepEqual(reconcileTranscript(sweep2, collectFromTranscript(turn2)), sweep2)
})

// ---------- memberLabel ----------

test("memberLabel agent+title 消歧 / 归属形态多层防御 / 兜底短 id", () => {
  assert.equal(memberLabel({ agentID: "build", title: "重构登录页" }, "ses_1"), "build (重构登录页)")
  assert.equal(memberLabel({ agent: { id: "build" } }, "ses_1"), "build")
  assert.equal(memberLabel({ agent: "build" }, "ses_1"), "build")
  assert.equal(memberLabel({ agentID: "build", title: "build" }, "ses_1"), "build") // 同名不加后缀
  assert.equal(memberLabel({ title: "review" }, "ses_1"), "review")
  assert.equal(memberLabel({}, "ses_abcdefgh"), "…cdefgh") // 尾 6 位兜底
})

test("memberLabel title 截断至 24 字符", () => {
  const long = "一".repeat(30)
  assert.equal(memberLabel({ agentID: "build", title: long }, "ses_1"), `build (${"一".repeat(24)})`)
})

// ---------- formatTrailLine ----------

test("formatTrailLine 本地 HH:MM + 触发徽标 + 错误标记 + skillID 兜底", () => {
  const base = (over: Partial<SkillRecord>): SkillRecord => ({ ts: T0, skillID: "review", trigger: "unknown", ...over })
  assert.equal(formatTrailLine(base({ trigger: "user", name: "Review" })), "10:30 Review (you)")
  assert.equal(formatTrailLine(base({ trigger: "model", name: "Review", status: "error" })), "10:30 Review (auto) ✗")
  assert.equal(formatTrailLine(base({ trigger: "model" })), "10:30 review (auto)") // 无 name 用 skillID
})

test("formatTrailLine 触发情境单行追加（←前缀,16 字符截断）", () => {
  const base = (over: Partial<SkillRecord>): SkillRecord => ({ ts: T0, skillID: "review", trigger: "model", ...over })
  assert.equal(formatTrailLine(base({ name: "Review", prompt: "帮我审查登录页" })), "10:30 Review (auto) ←帮我审查登录页")
  const long = "长".repeat(30)
  assert.equal(formatTrailLine(base({ name: "Review", prompt: long })), `10:30 Review (auto) ←${"长".repeat(16)}…`)
})

// ---------- extractTriggerContext（触发情境摘录） ----------

test("extractTriggerContext 取 ts 前最近一条用户消息，压平空白", () => {
  const messages = [
    { type: "user", time: { created: ts(0) }, parts: [{ type: "text", text: "较早的\n  请求" }] },
    { type: "assistant", time: { created: ts(1_000) }, parts: [{ type: "text", text: "模型回复" }] },
    { type: "user", time: { created: ts(2_000) }, parts: [{ type: "text", text: "@review 帮我审查" }] },
    { type: "user", time: { created: ts(60_000) }, parts: [{ type: "text", text: "晚于激活，不取" }] },
  ]
  assert.equal(extractTriggerContext(messages, ts(3_000)), "@review 帮我审查")
})

test("extractTriggerContext server context 形态：用户消息文本在顶层 m.text（实证 v2.2.5）", () => {
  const messages = [
    { type: "user", time: { created: ts(0) }, text: "为什么目前为止触发还是0", files: [], agents: [] },
    { type: "assistant", time: { created: ts(1_000) }, content: [{ type: "reasoning" }, { type: "tool" }] },
    { type: "synthetic", time: { created: ts(1_500) }, text: "skill-trail 报告已生成：…" }, // synthetic 不算用户消息
    { type: "user", time: { created: ts(60_000) }, text: "晚于激活，不取" },
  ]
  assert.equal(extractTriggerContext(messages, ts(2_000)), "为什么目前为止触发还是0")
})

test("extractTriggerContext 超 120 字符截尾加省略号；无用户消息返回 undefined", () => {
  const long = "长".repeat(200)
  const messages = [{ type: "user", time: { created: ts(0) }, parts: [{ type: "text", text: long }] }]
  const out = extractTriggerContext(messages, ts(1_000))!
  assert.equal(out.length, PROMPT_SNIPPET_MAX + 1) // 120 字符 + "…"
  assert.ok(out.endsWith("…"))
  assert.equal(extractTriggerContext([{ type: "assistant", time: { created: ts(0) }, parts: [] }], ts(1_000)), undefined)
  assert.equal(extractTriggerContext([], ts(1_000)), undefined)
})

// ---------- diffTotalsDelta / applyTotalsDelta / sanitizeTotals（累计层） ----------

test("diffTotalsDelta 新增记录出增量（user/model 分类）；重放同事件无增量", () => {
  const d1 = diffTotalsDelta([], [{ ts: ts(0), skillID: "review", trigger: "user" }])
  assert.deepEqual(d1, { review: { total: 1, userTriggers: 1, modelTriggers: 0, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(0) } })
  const d2 = diffTotalsDelta([], [{ ts: ts(5_000), skillID: "review", trigger: "model", callID: "c1" }])
  assert.deepEqual(d2, { review: { total: 1, userTriggers: 0, modelTriggers: 1, errors: 0, firstUsedAt: ts(5_000), lastUsedAt: ts(5_000) } })
  const replay = diffTotalsDelta([{ ts: ts(5_000), skillID: "review", trigger: "model", callID: "c1" }], [{ ts: ts(5_000), skillID: "review", trigger: "model", callID: "c1" }])
  assert.equal(replay, undefined)
})

test("diffTotalsDelta status 变 error 出计错增量；已是 error 重放无增量", () => {
  const prev: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1" }]
  const next: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1", status: "error" }]
  assert.deepEqual(diffTotalsDelta(prev, next), { review: { total: 0, userTriggers: 0, modelTriggers: 0, errors: 1, firstUsedAt: ts(0), lastUsedAt: ts(0) } })
  assert.equal(diffTotalsDelta(next, next), undefined)
})

test("diffTotalsDelta 同键 trigger 翻转（model→user）出修正增量：user +1 / model −1，总量不变", () => {
  const prev: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "model", callID: "c1" }]
  const next: SkillRecord[] = [{ ts: ts(0), skillID: "review", trigger: "user", callID: "c1" }]
  assert.deepEqual(diffTotalsDelta(prev, next), {
    review: { total: 0, userTriggers: 1, modelTriggers: -1, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(0) },
  })
  // user→model 降级不产出（reconcile 永不降级；出现也忽略,防误修正）
  assert.equal(diffTotalsDelta(next, prev), undefined)
})

test("applyTotalsDelta 修正增量叠加：userTriggers/modelTriggers 可下修,总量守恒", () => {
  const base: TotalsMap = { review: { total: 3, userTriggers: 1, modelTriggers: 2, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(2_000) } }
  const out = applyTotalsDelta(base, { review: { total: 0, userTriggers: 1, modelTriggers: -1, errors: 0, firstUsedAt: ts(1_000), lastUsedAt: ts(1_000) } })
  assert.deepEqual(out.review, { total: 3, userTriggers: 2, modelTriggers: 1, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(2_000) })
})

test("applyTotalsDelta 逐字段叠加 + 时间戳 min/max；sanitizeTotals 剥离畸形条目", () => {
  const base: TotalsMap = { review: { total: 1, userTriggers: 1, modelTriggers: 0, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(0) } }
  const out = applyTotalsDelta(base, {
    review: { total: 1, userTriggers: 0, modelTriggers: 1, errors: 0, firstUsedAt: ts(5_000), lastUsedAt: ts(5_000) },
    tdd: { total: 2, userTriggers: 0, modelTriggers: 2, errors: 0, firstUsedAt: ts(1_000), lastUsedAt: ts(2_000) },
  })
  assert.equal(out.review!.total, 2)
  assert.equal(out.review!.modelTriggers, 1)
  assert.equal(out.review!.lastUsedAt, ts(5_000))
  assert.equal(out.tdd!.total, 2)
  assert.deepEqual(
    sanitizeTotals({ review: { total: "x" }, junk: "nope", tdd: { total: 3, userTriggers: 1, modelTriggers: 2, errors: 0, firstUsedAt: 1, lastUsedAt: 2 } }),
    { tdd: { total: 3, userTriggers: 1, modelTriggers: 2, errors: 0, firstUsedAt: 1, lastUsedAt: 2 } },
  )
  assert.deepEqual(sanitizeTotals([1, 2]), {})
  assert.deepEqual(sanitizeTotals(null), {})
})

test("capTotals 超限丢最久未用", () => {
  const totals: TotalsMap = {
    a: { total: 1, userTriggers: 0, modelTriggers: 1, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(10_000) },
    b: { total: 1, userTriggers: 0, modelTriggers: 1, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(1_000) },
  }
  const out = capTotals(totals, 1)
  assert.deepEqual(Object.keys(out), ["a"]) // b 更久未用，被丢
})

// ---------- summarizeTrails（双层数据聚合） ----------

test("summarizeTrails 窗口聚合：分类计数 / agents 排序 / contexts 去重排序 / unused 窗口判定", () => {
  const sessions: Array<{ sessionID: string; records: SkillRecord[] }> = [
    {
      sessionID: "s1",
      records: [
        { ts: ts(0), skillID: "review", name: "Review", agent: "build", trigger: "model", status: "error", prompt: "帮我审查登录页" },
        { ts: ts(1_000), skillID: "review", name: "Review", agent: "build", trigger: "model", prompt: "帮我审查登录页" },
        { ts: ts(2_000), skillID: "review", name: "Review", agent: "plan", trigger: "model", prompt: "审查 API 设计" },
      ],
    },
    {
      sessionID: "s2",
      records: [{ ts: ts(3_000), skillID: "grilling", name: "Grill", trigger: "user", prompt: "@grilling 拷问我" }],
    },
  ]
  const summary = summarizeTrails(sessions, [
    { id: "review", name: "Review" },
    { id: "grilling", name: "Grill" },
    { id: "never-used", name: "Never" },
  ])
  const review = summary.skills.find((s) => s.skillID === "review")!
  assert.equal(review.total, 3)
  assert.equal(review.sessions, 1)
  assert.equal(review.errors, 1)
  assert.deepEqual(review.agents, [{ agent: "build", count: 2 }, { agent: "plan", count: 1 }])
  assert.deepEqual(review.contexts, ["审查 API 设计", "帮我审查登录页"]) // 新→旧 + 去重
  assert.equal(summary.unusedBasis, "window") // 无累计层 → 窗口判定
  assert.equal(summary.availableCount, 3)
  assert.deepEqual(summary.unused, [{ id: "never-used", name: "Never" }])
  assert.equal(summary.recordCount, 4)
})

test("summarizeTrails 累计层：窗口外 skill 照样成行；unused 转终身判定", () => {
  const totals: TotalsMap = {
    legacy: { total: 9, userTriggers: 2, modelTriggers: 7, errors: 1, firstUsedAt: ts(-100_000), lastUsedAt: ts(-50_000) },
    review: { total: 5, userTriggers: 1, modelTriggers: 4, errors: 2, firstUsedAt: ts(0), lastUsedAt: ts(2_000) },
  }
  const sessions: Array<{ sessionID: string; records: SkillRecord[] }> = [{ sessionID: "s1", records: [{ ts: ts(0), skillID: "review", name: "Review", trigger: "model" }] }]
  const summary = summarizeTrails(sessions, [{ id: "review" }, { id: "no-data" }], totals)
  const legacy = summary.skills.find((s) => s.skillID === "legacy")!
  assert.equal(legacy.total, 0) // 窗口内 0 次
  assert.equal(legacy.lifetime.total, 9) // 终身 9 次
  assert.equal(summary.skills[0]!.skillID, "legacy") // 按累计次数降序
  assert.equal(summary.unusedBasis, "totals")
  assert.deepEqual(summary.unused, [{ id: "no-data", name: undefined }])
  assert.ok(summary.lifetimeCoverage && summary.lifetimeCoverage.from === ts(-100_000))
})

test("summarizeTrails 记录缺 name 时回退 available 清单名（2026-11-04 报告：grilling/pinpoint 行无名）", () => {
  const summary = summarizeTrails(
    [{ sessionID: "s1", records: [{ ts: ts(0), skillID: "opencode", agent: "build", trigger: "model", status: "completed" }] }],
    [{ id: "opencode", name: "OpenCode" }, { id: "other", name: "Other" }],
  )
  assert.equal(summary.skills[0]!.name, "OpenCode") // 记录无 name → 清单名兜底
})

// ---------- 累计层 ↔ 明细层一致性（2026-11-04 报告双异常的复现与修复锁） ----------
// 现场报告（%TEMP%/skill-trail-report.json）两处分歧：
//   ① opencode：窗口 4 条 vs lifetime.total=2，lifetime.firstUsedAt 晚于窗口首条
//      ——明细已持久化而 delta 未落账（落账失败进程退出 / 旧版无累计层时代的记录经
//      hydrate/sweep 基线恢复且有意不差分）→ 终身永久漏计。
//   ② improve-codebase-architecture：lifetime.total=2 vs 窗口 1 条，first=last 同刻
//      ——明细写失败静默降级 + 累计照常入账 → 重启后 sweep 冷装载空基线重扫
//      transcript → 同一激活再计一次 → 终身双计（窗口因精确键去重仍 1）。
// 修复：① 读时 heal（单向 max——lifetime ⊇ 窗口是结构不变量，明细可裁剪而累计
//   永不清算，低于是账错、高于是裁剪正常态，反向不修）；② 增量落账闸
//   （createDeltaLedger：明细持久化成功才释放 delta 进 flush，两侧同生同殒）。

test("复现①并修复：明细有账而累计层缺账 → healTotals 单向补齐（lifetime ≥ 窗口）", () => {
  // 窗口 4 条 opencode：两条旧记录无 name（旧版插件所采，先于累计层存在）
  const sessions: Array<{ sessionID: string; records: SkillRecord[] }> = [
    {
      sessionID: "s-old",
      records: [
        { ts: ts(0), skillID: "opencode", agent: "build", trigger: "model", callID: "c1", status: "completed" },
        { ts: ts(60_000), skillID: "opencode", agent: "build", trigger: "model", callID: "c2", status: "completed" },
      ],
    },
    {
      sessionID: "s-new",
      records: [
        { ts: ts(120_000), skillID: "opencode", name: "OpenCode", agent: "build", trigger: "model", callID: "c3", status: "completed" },
        { ts: ts(180_000), skillID: "opencode", name: "OpenCode", agent: "build", trigger: "model", callID: "c4", status: "completed" },
      ],
    },
  ]
  // 累计层只吃到后两条（首用时刻=后两条的首条，晚于窗口首条 120s）
  const totals: TotalsMap = {
    opencode: { total: 2, userTriggers: 0, modelTriggers: 2, errors: 0, firstUsedAt: ts(120_000), lastUsedAt: ts(180_000) },
  }
  const healed = healTotals(totals, sessions)
  const row = summarizeTrails(sessions, [], healed).skills.find((s) => s.skillID === "opencode")!
  assert.equal(row.total, 4) // 窗口 4（既有行为）
  assert.equal(row.lifetime.total, 4) // 终身追平窗口（修复前为 2 → 复现异常①）
  assert.equal(row.lifetime.modelTriggers, 4)
  assert.equal(row.lifetime.firstUsedAt, ts(0)) // 首用回拨到真实首条
})

test("healTotals 累计层完全缺账的 skill 从窗口成账；正常态（累计高于窗口=裁剪）不动", () => {
  const sessions: Array<{ sessionID: string; records: SkillRecord[] }> = [
    { sessionID: "s1", records: [
      { ts: ts(0), skillID: "grilling", trigger: "user" },
      { ts: ts(1_000), skillID: "grilling", trigger: "user", status: "error" },
    ]},
  ]
  const healed = healTotals({}, sessions) // 累计层整体缺失（旧版升级现场）
  assert.deepEqual(healed.grilling, { total: 2, userTriggers: 2, modelTriggers: 0, errors: 1, firstUsedAt: ts(0), lastUsedAt: ts(1_000) })
  // 反向：累计 9 vs 窗口 1（明细层 64 会话裁剪的正常态）→ 不下调（无法区分裁剪与双计）
  const pruned: TotalsMap = { legacy: { total: 9, userTriggers: 2, modelTriggers: 7, errors: 0, firstUsedAt: ts(-100_000), lastUsedAt: ts(-50_000) } }
  const kept = healTotals(pruned, [{ sessionID: "s1", records: [{ ts: ts(0), skillID: "legacy", trigger: "model" }] }])
  assert.equal(kept.legacy!.total, 9)
})

test("createDeltaLedger：hold 扣留 / settle 释放 / 同会话多次 hold 折叠 / 空结算", () => {
  const ledger = createDeltaLedger()
  const d = (id: string): TotalsMap => ({ [id]: { total: 1, userTriggers: 1, modelTriggers: 0, errors: 0, firstUsedAt: ts(0), lastUsedAt: ts(0) } })
  ledger.hold("s1", d("review"))
  ledger.hold("s1", d("tdd")) // 同会话第二条：折叠为一份
  ledger.hold("s2", d("grilling"))
  assert.equal(ledger.held(), 2)
  const released = ledger.settle("s1")!
  assert.equal(released.review!.total, 1)
  assert.equal(released.tdd!.total, 1)
  assert.equal(ledger.held(), 1) // s2 仍在押
  assert.equal(ledger.settle("s1"), undefined) // 再结算为空
  assert.equal(ledger.settle("s2")!.grilling!.total, 1)
  assert.equal(ledger.held(), 0)
})

test("复现②（接线语义）：明细未持久化 → delta 不入账；重启空基线重扫恰计一次", () => {
  const mentions = collectFromTranscript([inlineMentionMessage("improve-codebase-architecture", ts(0))])
  // 实例 A（首回合）：sweep 空基线入账 → delta 扣留；明细持久化失败（静默降级，
  // settle 不触发）→ 进程退出时 delta 随内存消失，stats:totals 与明细层同时缺席
  const ledgerA = createDeltaLedger()
  const next1 = reconcileTranscript([], mentions)
  ledgerA.hold("s1", diffTotalsDelta([], next1)!)
  let statsTotals: TotalsMap = {} // 重启后从 storage 恢复的累计层（A 的 delta 未落账）
  // 实例 B（重启后）：storage 无基线 → transcript 重扫出同一记录；这次持久化成功
  const ledgerB = createDeltaLedger()
  const next2 = reconcileTranscript([], mentions)
  const d2 = diffTotalsDelta([], next2)!
  assert.equal(d2["improve-codebase-architecture"]!.total, 1)
  ledgerB.hold("s1", d2)
  const released = ledgerB.settle("s1")! // 持久化成功 → 释放
  statsTotals = applyTotalsDelta(statsTotals, released)
  // 恰计一次：无门控的旧路径在此为 2（A 已入账 + B 重扫再入账）→ 复现异常②
  assert.equal(statsTotals["improve-codebase-architecture"]!.total, 1)
})

// ---------- renderReportHTML（自包含报告） ----------

test("renderReportHTML 转义用户数据 + 内嵌 JSON 防 </script> 逃逸 + 导出链接", () => {
  const summary = summarizeTrails(
    [{ sessionID: "s1", records: [{ ts: ts(0), skillID: "<x>", name: "Evil <script>", trigger: "user", prompt: "</script>alert(1)" }] }],
    [{ id: "<y>" }],
  )
  const html = renderReportHTML({ summary, sessions: [] })
  assert.ok(html.includes("Evil &lt;script&gt;")) // 行内转义
  assert.ok(html.includes("&lt;/script&gt;")) // 情境摘录转义
  const jsonBlock = html.split('id="trail-data">')[1]!.split("</script>")[0]!
  assert.ok(!jsonBlock.includes("<")) // 内嵌 JSON 中所有 < 已转义为 \u003c
  assert.ok(html.includes('href="skill-trail-report.json"')) // 导出链接
  assert.ok(html.includes("&lt;y&gt;")) // unused 清单转义
})

test("renderReportHTML 空数据不炸，给出空态提示；清单不可用时显式警告", () => {
  const html = renderReportHTML({ summary: summarizeTrails([], []), sessions: [] })
  assert.ok(html.includes("从未触发"))
  assert.ok(html.includes("0 条"))
  assert.ok(html.includes("可用 skill 清单不可用")) // availableCount=0 → 警告而非误导性"都有触发记录"
  const htmlWithList = renderReportHTML({
    summary: summarizeTrails(
      [{ sessionID: "s1", records: [{ ts: ts(0), skillID: "a", trigger: "user" }, { ts: ts(1_000), skillID: "b", trigger: "model" }] }],
      [{ id: "a" }, { id: "b" }],
    ),
    sessions: [],
  })
  assert.ok(htmlWithList.includes("可见 skill 2 个"))
  assert.ok(htmlWithList.includes("无——当前可见的 skill 都有触发记录")) // 全部有账 → 空态提示
  const htmlWithUnused = renderReportHTML({
    summary: summarizeTrails([], [{ id: "a" }, { id: "b" }]),
    sessions: [],
  })
  assert.ok(htmlWithUnused.includes("可见 skill 2 个"))
  assert.ok(htmlWithUnused.includes('<ul><li>')) // 有未触发 → 清单渲染而非空态提示
})
