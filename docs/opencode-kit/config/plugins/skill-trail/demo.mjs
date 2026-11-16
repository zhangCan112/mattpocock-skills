// 演示报告生成器（npm run demo）——零依赖渲染 renderReportHTML，样式/交互预览与报告冒烟两用
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderReportHTML, summarizeTrails } from "./trail.ts"

const h = 3600_000
const now = Date.now()
const t = (hoursAgo) => now - hoursAgo * h

const sessions = [
  {
    sessionID: "ses_demo_1",
    records: [
      { ts: t(0.5), skillID: "code-review", name: "code-review", agent: "build", trigger: "model", status: "completed", prompt: "帮我看看这次提交有没有问题，重点看并发部分" },
      { ts: t(0.6), skillID: "tdd", name: "tdd", agent: "build", trigger: "model", status: "error", prompt: "给 trail.ts 补合并的测试，先写失败用例" },
      { ts: t(0.7), skillID: "code-review", name: "code-review", agent: "build", trigger: "model", prompt: "review 一下侧栏渲染的重构" },
    ],
  },
  {
    sessionID: "ses_demo_2",
    records: [
      { ts: t(5), skillID: "grilling", name: "grilling", trigger: "user", prompt: "@grilling 拷问一下我的插件商店设计" },
      { ts: t(5.2), skillID: "diagnosing-bugs", name: "diagnosing-bugs", agent: "general", trigger: "model", status: "completed", prompt: "这个 bug 只有在生产环境复现，帮我系统排查" },
      { ts: t(5.4), skillID: "diagnosing-bugs", name: "diagnosing-bugs", agent: "general", trigger: "model", status: "completed", prompt: "还是那个内存泄漏，换个思路诊断" },
    ],
  },
  {
    sessionID: "ses_demo_3",
    records: [
      { ts: t(30), skillID: "tdd", name: "tdd", agent: "build", trigger: "model", status: "completed", prompt: "红绿重构流程走一遍这个模块" },
      { ts: t(30.3), skillID: "research", name: "research", trigger: "user", prompt: "@research 调研一下 V2 插件 storage 的持久化机制" },
    ],
  },
]

const totals = {
  "code-review": { total: 42, userTriggers: 3, modelTriggers: 39, errors: 1, firstUsedAt: t(24 * 60), lastUsedAt: t(0.5) },
  tdd: { total: 17, userTriggers: 1, modelTriggers: 16, errors: 2, firstUsedAt: t(24 * 45), lastUsedAt: t(0.6) },
  "diagnosing-bugs": { total: 9, userTriggers: 2, modelTriggers: 7, errors: 0, firstUsedAt: t(24 * 30), lastUsedAt: t(5.4) },
  grilling: { total: 6, userTriggers: 5, modelTriggers: 1, errors: 0, firstUsedAt: t(24 * 20), lastUsedAt: t(5) },
  research: { total: 4, userTriggers: 4, modelTriggers: 0, errors: 0, firstUsedAt: t(24 * 50), lastUsedAt: t(30.3) },
  // 会话早已裁剪出窗口，只剩累计层账目——报告里应照样成行且"窗口 0 次"
  prototype: { total: 23, userTriggers: 20, modelTriggers: 3, errors: 0, firstUsedAt: t(24 * 90), lastUsedAt: t(24 * 12) },
}

const available = [
  { id: "code-review", name: "code-review" },
  { id: "tdd", name: "tdd" },
  { id: "diagnosing-bugs", name: "diagnosing-bugs" },
  { id: "grilling", name: "grilling" },
  { id: "research", name: "research" },
  { id: "prototype", name: "prototype" },
  { id: "pinpoint", name: "pinpoint" },
  { id: "wizard", name: "wizard" },
  { id: "domain-modeling", name: "domain-modeling" },
]

const summary = summarizeTrails(sessions, available, totals)
const out = join(tmpdir(), "skill-trail-report-demo.html")
writeFileSync(out, renderReportHTML({ summary, sessions }), "utf8")
console.log(`demo report -> ${out}`)
