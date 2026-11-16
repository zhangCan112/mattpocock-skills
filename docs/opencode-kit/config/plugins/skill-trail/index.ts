// skill-trail 插件 · server 部件 —— skill 调用采集面 + 统计报告出口(目录插件 index.ts,与 tui.tsx 成对装载)
// 本文件 = 接线层(2026-11-04 治理轮起):tool/事件/命令三类 hook 注册、事件载荷 unknown 收窄、
//   纯函数 apply* 组合、/skill-trail 报告出口(openReport:聚合双层数据 → 自包含 HTML+JSON 落
//   tmpdir → 开浏览器 → synthetic 回报)。持久化状态机(LRU 逐出 / 按会话串行落盘 / 增量落账闸
//   / 累计层读-改-写 / 扫频限流 / 冷会话水合 / 启动清理)在 store.ts(TrailStore,IO 注入,
//   node --test 直测);纯函数(采集/合并/对账/聚合/渲染)在 trail.ts——分层纪律与 compaction.ts
//   (Watcher)、handoff-core.ts 同款。域词见 GLOSSARY.md(明细层/累计层/水合/落账/对账/扫频)。
// 职责:tool.execute.before/after(tool==="skill")采主信号(含 agent 归属与成败);
//   session.skill.activated 兜 SDK 显式装载路(2026-11-03 定界:仅 @deprecated 的
//   session.skill API 发射,2.2.5 桌面 @mention/工具调用路均不发射);回合结束
//   (session.execution.*)扫 transcript × 事件账对账(reconcileTranscript)补用户
//   @mention 盲区。记录按 sessionID 落 ctx.storage(durable,无 TUI 的 headless run
//   也留痕);TUI 侧栏另从 transcript 回填,双源互不依赖(server↔TUI storage 命名
//   空间不保证共享,不押注)。
// 双层数据:明细层(trail:* 滚动窗口,防膨胀,供情境回看)+ 累计层(stats:totals
//   终身计数,永不清算,供 /skill-trail 报告的"从未触发/使用率"判定——明细裁剪不影响它)。
//   一致性(2026-11-04 报告双异常修复):增量先落 createDeltaLedger 扣留,明细持久化
//   成功才释放进累计层(防"明细丢、累计双计");报告读数对明细窗口做 healTotals 读时
//   对账(lifetime ≥ 窗口单向修复,治"明细在、累计缺账"的历史分歧)。
// 纪律:transform 仅命令注册一处(editor.add 低风险,全链防御;其余零 transform 零 reload,
//   transform 失败会连坐禁用整个插件);全链 try/catch 降级,采集/报告失败绝不影响会话;
//   探针默认关(SKILL_TRAIL_PROBE=1 时 appendFileSync 到 tmpdir JSONL——console.log 不进
//   --print-logs,冒烟走探针文件)。
// 风格(2026-11-03 轮):对齐 Google TypeScript Style Guide——任意型零手写(宿主面吃 SDK
//   Plugin.Context,动态载荷 unknown + obj/str 收窄;SkillRecord/SkillTotals 转 type alias
//   过 storage Json 边界),行为不变。
import { Plugin } from "@opencode/plugin"
import { appendFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import {
  applyActivated,
  applyToolAfter,
  applyToolBefore,
  healTotals,
  obj,
  renderReportHTML,
  str,
  summarizeTrails,
} from "./trail.ts"
import { TrailStore, type TrailStoreIO } from "./store.ts"

const PROBE_ENV = "SKILL_TRAIL_PROBE"
const PROBE_FILE = "opencode-skill-trail-probe.jsonl"
const REPORT_HTML = "skill-trail-report.html"
const REPORT_JSON = "skill-trail-report.json"

function probe(entry: Record<string, unknown>): void {
  if (process.env[PROBE_ENV] !== "1") return
  try {
    appendFileSync(join(tmpdir(), PROBE_FILE), JSON.stringify(entry) + "\n", "utf8")
  } catch {
    // 探针失败静默（观测件绝不反噬主流程；行为差异点：Windows 下探针文件被别的进程
    // 独占打开（如编辑器查看中）时 append 会 EBUSY——平台文件锁差异，跳过该行即可）
  }
}

function evTime(ev: unknown): number {
  const direct = obj(obj(ev).time).created
  const nested = obj(obj(obj(ev).data).time).created
  const t = direct ?? nested
  return typeof t === "number" && t > 0 ? t : Date.now()
}

/** 跨平台用系统默认程序打开文件（无 opener 静默——synthetic 消息里已有路径兜底） */
function openInBrowser(path: string): void {
  try {
    // 平台三分支（行为差异点）：win32 走 cmd /c start——空串 "" 占位窗口标题，
    // 缺它时含空格/被引号包裹的路径会被 start 当标题吞掉、文件打不开；darwin 用
    // open，其余（linux/bsd）用 xdg-open。spawn 数组传参免 shell 注入，路径由 Node 转义。
    const bin = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open"
    const args = process.platform === "win32" ? ["/c", "start", "", path] : [path]
    const child = spawn(bin, args, { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {
    // 打开失败静默
  }
}

export default Plugin.define({
  id: "skill-trail",
  async setup(ctx: Plugin.Context) {
    // TrailStoreIO:SDK ctx 装配的真 adapter（store.test.ts 的内存 fake 是第二个 adapter，
    // 坐实 seam）。防御式 ?. + 缺面回落 resolved 值——与原内联调用同降级语义
    // （storage 缺席 → get 得 undefined / set 无操作，store 侧 catch 照常降级）。
    const io: TrailStoreIO = {
      get: (key) => ctx.storage?.get?.(key) ?? Promise.resolve(undefined),
      set: (key, value) => ctx.storage?.set?.(key, value) ?? Promise.resolve(),
      scan: (query) => ctx.storage?.scan?.(query) ?? Promise.resolve(undefined),
      remove: (key) => ctx.storage?.remove?.(key) ?? Promise.resolve(),
      sessionContext: (sessionID) => ctx.session?.context?.({ sessionID }) ?? Promise.resolve(undefined),
      probe,
      now: () => Date.now(),
    }
    const store = new TrailStore(io)
    await store.init() // 累计层恢复 + 装载自证探针；hook 注册前 await——账已恢复才采信差分
    void store.prune() // 启动清理（fire-and-forget，原 pruneStorage 同款）

    /** /skill-trail：聚合双层数据 → HTML + JSON 落 tmpdir → 开浏览器 → synthetic 回报 */
    async function openReport(sessionID: string): Promise<void> {
      const { sessions } = await store.scanTrail()
      let available: Array<{ id: string; name?: string }> = []
      try {
        // 形态兼容：数组 / {data} / {skills}（实证未定，探针兜底——空清单时记录实际形态）；
        // 返回值按不可信载荷 unknown 收窄
        const res: unknown = await ctx?.skill?.list?.()
        const viaData = obj(res).data
        const viaSkills = obj(res).skills
        const list = Array.isArray(res) ? res
          : Array.isArray(viaData) ? viaData
          : Array.isArray(viaSkills) ? viaSkills
          : undefined
        if (list === undefined) {
          probe({
            hook: "report.skills.unrecognized",
            type: res === null ? "null" : typeof res,
            keys: res && typeof res === "object" ? Object.keys(res).slice(0, 12) : [],
          })
        } else if (list.length === 0) {
          probe({ hook: "report.skills.empty" })
        }
        available = (list ?? [])
          .map((s) => {
            const sv = obj(s)
            return { id: str(sv.id), name: typeof sv.name === "string" ? sv.name : undefined }
          })
          .filter((s) => s.id !== "")
      } catch (e) {
        probe({ hook: "report.skills.failed", message: e instanceof Error ? e.message : String(e) })
      }
      // 累计层取数：storage 新鲜态 + 本实例已 durable 未落账增量（多 location 实例并存时，
      // 本实例内存态可能落后于别处已落账的计数——以 storage 为准）；再对明细窗口做
      // 读时 heal（强制 lifetime ≥ 窗口，修旧版缺账/落账丢失的历史分歧，见 healTotals 头注）
      const reportTotals = await store.reportTotals()
      const trailSessions = sessions.map(({ sid, records }) => ({ sessionID: sid, records }))
      const summary = summarizeTrails(trailSessions, available, healTotals(reportTotals, trailSessions))
      const htmlPath = join(tmpdir(), REPORT_HTML)
      const jsonPath = join(tmpdir(), REPORT_JSON)
      writeFileSync(htmlPath, renderReportHTML({ summary, sessions: trailSessions }), "utf8")
      writeFileSync(jsonPath, JSON.stringify({ summary, sessions }, null, 2), "utf8")
      probe({ hook: "report.generated", sessions: sessions.length, skills: summary.skills.length, unused: summary.unused.length })
      openInBrowser(htmlPath)
      await ctx?.session?.synthetic?.({
        sessionID,
        text: `skill-trail 报告已生成：\n- HTML（已尝试在浏览器打开）：${htmlPath}\n- JSON（完整原始数据，可导出）：${jsonPath}`,
      })
    }

    // ① 主信号：skill 工具调用（模型自动路径，含 agent 归属 + 成败）
    try {
      await ctx?.tool?.hook?.("execute.before", (input) => {
        try {
          if (input?.tool !== "skill") return
          const sid = input.sessionID
          const skillID = str(obj(input.input).id)
          if (typeof sid !== "string" || typeof skillID !== "string") return
          const t = evTime(input)
          store.commit(sid, applyToolBefore(store.recordsOf(sid), {
            callID: typeof input.id === "string" ? input.id : undefined,
            skillID,
            agent: typeof input.agent === "string" ? input.agent : undefined,
            ts: t,
          }))
          store.enrich(sid, skillID, t)
          probe({ hook: "tool.before", sessionID: sid, skillID, agent: input.agent })
        } catch {
          // 降级：采集失败不影响工具执行
        }
      })
      await ctx?.tool?.hook?.("execute.after", (input) => {
        try {
          if (input?.tool !== "skill" || input?.status !== "completed" && input?.status !== "error") return
          const sid = input.sessionID
          const skillID = str(obj(input.input).id)
          if (typeof sid !== "string" || typeof skillID !== "string") return
          store.commit(sid, applyToolAfter(store.recordsOf(sid), {
            callID: typeof input.id === "string" ? input.id : undefined,
            skillID,
            status: input.status,
            ts: evTime(input),
          }))
          probe({ hook: "tool.after", sessionID: sid, skillID, status: input.status })
        } catch {
          // 降级
        }
      })
    } catch {
      // hook 注册失败：采集面缺席，不反噬插件装载
    }

    // ② 确认信号 + 回合检查点：session.skill.activated（SDK 显式装载路兜底）+
    //    session.execution.*（回合终态,触发 transcript 扫描对账——@mention 补盲主路）
    let cleanup: (() => void) | undefined
    try {
      const controller = new AbortController()
      void (async () => {
        try {
          const stream = ctx?.event?.subscribe?.({
            types: [
              "session.skill.activated",
              "session.execution.succeeded",
              "session.execution.failed",
              "session.execution.interrupted",
            ],
            signal: controller.signal,
          })
          if (!stream) return
          for await (const ev of stream) {
            const v = obj(ev) // 事件载荷按不可信数据处理（obj 收口，不直达属性）
            const d = obj(v.data)
            const sid = d.sessionID
            if (typeof sid !== "string") continue
            if (v.type === "session.skill.activated") {
              const skillID = str(d.id)
              if (typeof skillID !== "string" || !skillID) continue
              const name = d.name
              const t = evTime(ev)
              store.commit(sid, applyActivated(store.recordsOf(sid), {
                skillID,
                name: typeof name === "string" ? name : undefined,
                ts: t,
              }))
              store.enrich(sid, skillID, t)
              probe({ hook: "skill.activated", sessionID: sid, skillID, name })
            } else {
              store.sweep(sid, str(v.type))
            }
          }
        } catch {
          // 降级：订阅循环异常不影响主流程
        }
      })()
      cleanup = () => controller.abort()
    } catch {
      // event.subscribe 不可用：静默降级
    }

    // ③ 报告出口：/skill-trail 命令（transform 全插件仅此一处，见头注纪律）
    try {
      await ctx?.command?.transform?.((editor) => {
        editor.add({
          name: "skill-trail",
          description: "生成并打开 skill 使用统计报告（HTML+JSON，含触发情境与未触发清单）",
          execute: async ({ sessionID }) => {
            try {
              await openReport(sessionID)
            } catch {
              probe({ hook: "report.failed" })
              try {
                await ctx?.session?.synthetic?.({ sessionID, text: "skill-trail 报告生成失败（可设 SKILL_TRAIL_PROBE=1 复现并查看探针）" })
              } catch {
                // synthetic 失败静默
              }
            }
          },
        })
      })
    } catch {
      // 命令注册失败：报告出口缺席，采集面不受影响
      probe({ hook: "command.register.failed" })
    }

    return () => {
      try {
        cleanup?.()
      } catch {
        // 清理失败静默
      }
    }
  },
})
