// auto-handoff plugin — 自动跨会话交接（接力）工具 handoff_to（v0.15；
// v0.18 E-final：跨岗接力改「新会话 + 薄交接」——上下文随切；
// v0.19b TUI 跟随：伴生目录件 tui.ts（v0.20 定稿，宿主 2.2.1 契约）；
// v0.21 命令名前置校验 + 已建会话的 command 失败改「成功带警示」+ 吞错处落日志；
// v0.22 改名轮：luna-route / luna_route_to → auto-handoff / handoff_to——「luna」是
//   luna-app 私有命名族，源仓库用通用名。
// v0.23 治理轮：纯逻辑抽 handoff-core.ts（CoreIO 注入，node --test 直测——
//   compaction.ts / trail.ts 同款分层）；本文件收窄为接线层，行为不变。
// v0.24 风格轮：对齐 Google TypeScript Style Guide——任意型零手写（宿主面吃 SDK
//   Plugin.Context，逻辑层 HandoffHost 结构面 + obj/str 收窄），行为不变。
// v0.25 定位独立化轮（2026-11-03 用户定调）：拆「交接家族」叙事——本件 = Agent 之间
//   的接棒（跨会话且可跨岗：session.command 切岗，受众是接棒的下一位，交接只装当前
//   接力目标、不预告下游），handoff-compaction = 同一 Agent 的新陈代谢（受众：遗忘后
//   的自己）。两件零运行时耦合（互不 import、模板各自持有副本），六段模板同源
//   （handoff skill）但各自独立演进、无对齐义务。行为零变更（注释+文档轮）。
// v0.26 提示词原版轮（2026-11-03 用户拍板）：薄交接模板换 Matt handoff skill 英文原版
//   （三规则原句 + 六段英译骨架，适配点见 handoff-core.ts 模板注）；接力焦点（/命令 +
//   用户需求）透传给生成器——Matt「按参数裁剪」规则的插件形态（此前 text 不进提示词）。
//   运行时描述清理：去 to-spec / grill-with-docs 等旧示例（二者今为 skill 非命令，描述
//   曾混淆两个注册表），命令名规则改通用表述、以入口校验的活清单为准。
// v0.27 去模型化轮（2026-11-04 用户定调）：入参 command+text → agent+prompt——工具变
//   通用件，不依赖目标仓命令清单/models.json；create({agent}) 生而落岗（不再 create 后
//   靠命令 frontmatter 切岗）；任务经 session.prompt 下发（不再靠命令模板展开，工件路标
//   由调用方写进 prompt）；create/prompt/generate 均不带 model——模型选择归 agent 配置
//   （当年 livefire「回落坏默认模型 ECONNREFUSED」根因是环境默认模型配坏，归环境修）。
//   同会话降级链对应改 switchAgent+prompt；title 前缀契约「接力 /」→「接力 @」
//   （tui.ts 同轮改，两半唯一契约勿改单边）。
// v0.28 接力链轮（2026-11-10）：create 落 metadata 链路（relay.parent = 原会话 id，
// handoff-core.ts 实现）——本件行为零变更（工具入参/文案/降级链均不动），仅头注记档。
// v0.29 岗位模型轮（2026-11-10 用户反馈）：V2 下 primary 会话「选岗不改模型」，岗配置
//   model 须显式落 create——handoff-core.ts handoffToFresh 实现（agent.list 读岗模型 →
//   存在性校验 → create 携 model，失败去模型重试）；本件回执随带实际模型
//   「handed off to @agent(provider/model#variant)」便于一眼核对分层是否生效。
//   同会话降级链（switchAgent）不切模型——那是用户当前会话，模型归属用户手选（边界：
//   只影响 handoff 建的新会话）。
//
// 语义变更依据：
//   - 平台切岗（同会话 switchAgent）不裁剪消息流——旧上下文全量灌入新岗（用户报的串味根因）
//   - fork = 复制历史的时光机（livefire 修正），插件域亦无 fork——不可用作 clear
//   - E-final 主链：ctx.session.create 新会话（天然干净、原会话封箱保全，v0.27 起
//     create 即带 agent——生而落岗）→ synthetic 注入薄交接（A 视角离屏生成，Matt
//     Pocock handoff 规则：只装工件里没有的对话层信息，落内存/随会话走不进 repo）→
//     prompt 对新会话下发任务文本
//   - 降级链：create 级失败 → 回落旧行为（同会话 switchAgent+prompt），并以 context
//     hook 记边界裁剪旧段（保底防漏）；交接生成失败 → synthetic 注最小指针包
//
// 平台面（冒烟实证 + livefire；SDK 2.0.32 生成类型考证）：
//   - ToolEditor.add 注册自定义工具；output 必须声明且 execute 必须返回 {output}
//   - Tool.Context 自带 sessionID/agent/messageID
//   - ctx.session 域方法（@opencode/plugin promise/session.d.ts SessionDomain）：
//     create / synthetic / prompt / switchAgent / context / hook 均在清单——签名以
//     运行时为准，任一失败走降级链（不阻断接力）
//   - serve(web) headless 无 runner：执行类 HTTP API 404——插件同进程域调用不受影响
//
// TUI 跟随（v0.20）：本半只创建会话（title 固定
// 「接力 @<agent> <简述>」）；伴生 tui.ts（源仓库同目录；部署侧须目录化，如
// .opencode/plugins/auto-handoff-tui/tui.ts）订阅 session.created 按
// title 前缀特征跟随。两半通过事件总线解耦，互不依赖存活（任一半失败不连坐另一半）。
// TUI 半发现 = 实跑宿主 2.2.1 扫 plugins/ 下目录件的 tui.ts（冒烟实证）——
// TUI 半必须目录化，平铺 .ts 不进 TUI 视野；server 半（本件）部署平铺单文件。
//
// 退出码语义保持 0/2/3（工具形态以返回文本标记）：
//   0 = handed off（新会话接力成功；或 create 不可用时的同会话降级——文案标明；
//        v0.21：新会话已建而任务下发失败 → 亦归 0 态，文案带 ⚠ 警示——
//        会话已建成、交接已注入，降级反而制造第二个失败现场
//   2 = 环境不可用（create 与同会话降级两级都失败）→ 调用方回退「请用户手动切岗下发」
//   3 = 用法错误（参数缺、v0.27 agent 不在清单）→ 检查参数后重试
// v0.27 agent 前置校验（承 v0.21 命令名校验的根因防御：调用方猜名必炸，两级连炸出
//   假 FAIL(2) + 无效回退指引）：execute 入口先 ctx.agent.list（server 插件域，
//   AgentInfo 的 id/name 并入有效集）校验，无效 → 3 态附可用清单，不建孤儿会话。
//   清单不可读/为空 → 视为不可校验，不阻断主链（防误杀）。
// 插件隔离：本插件只做 tool 注册 + context hook 保底——失败不抛出插件，
// 但 v0.21 起吞错处一律 console.log('[auto-handoff] …')（取证盲区：插件吞掉的
// 错误 opencode.log 里 grep 不到，只能靠 DB 还原——静默降级 ≠ 无声降级）。
import { Plugin } from "@opencode/plugin"
import {
  errText,
  HANDOFF_TOOL,
  handoffResult,
  handoffToFresh,
  lastMessageID,
  listAgentNames,
  obj,
  trimMessagesBefore,
  str,
  type CoreIO,
} from "./handoff-core.ts"

// 接线层 IO：console 落到这里——逻辑层 handoff-core.ts 零平台依赖直测
// （v0.27 去模型化后无 fs 面——models.json 已退役，IO 只剩日志）
const io: CoreIO = {
  log: (message) => console.log(message),
}

// ---- 降级边界记录 + context hook 保底 ----
// 仅降级链（同会话切岗）会写入；主链（新会话）天然干净无需裁剪。
const fallbackBounds = new Map<string, string>() // sessionID -> 旧段最后一条 messageID

export default Plugin.define({
  id: "auto-handoff",
  async setup(ctx: Plugin.Context) {
    // context hook 保底（仅降级链生效；不可用则不裁，fork/create 已保证主链干净）
    try {
      await ctx.session.hook("context", async (event) => {
        try {
          const sid = event?.sessionID
          const boundID = typeof sid === "string" ? fallbackBounds.get(sid) : undefined
          if (!boundID || !Array.isArray(event?.messages)) return
          // 边界回写单点断言：裁剪结果含合成边界提示（非 Message 接口形，类型系统
          // 无法表达），宿主按宽松消息面消费——livefire 实证可运行
          event.messages = trimMessagesBefore(event.messages, boundID) as typeof event.messages
        } catch {
          // 裁剪失败 → 保持现状
        }
      })
    } catch {
      // hook 注册失败：主链（新会话）不受影响
    }
    await ctx.tool.transform((editor) => {
      editor.add({
        name: HANDOFF_TOOL,
        description:
          "把当前任务接力到新会话（原会话封箱保全 + 新会话带薄交接干净起步、生而落在指定 agent 岗并应用岗位配置的 model——岗无 model 或模型不可用时沿用宿主默认，回执注明；交接文档按接力焦点裁剪，只装当前一步）。" +
          "成功返回 handed off to @<agent>(provider/model#variant)（新会话 ses_…，括号内为岗位模型，岗无模型时缺席）；新会话已建而任务下发失败返回成功带 ⚠ 警示；" +
          "create 不可用时回落同会话切岗（文案标明）；失败返回 handoff FAIL(2|3) 与回退指引。" +
          "agent 必须是本项目已注册的 agent（以入口校验返回的可用清单为准）；" +
          "prompt 是新会话的首轮任务文本——工件路标（spec/tickets/map 等）请写进 prompt（无命令模板代发）。" +
          "无效 agent 会在入口被拒（FAIL(3) 附可用清单），不会建孤儿会话。",
        input: {
          type: "object",
          properties: {
            agent: { type: "string", description: "目标 agent id——接棒岗位，新会话生而落此岗（须在入口校验返回的可用清单内）" },
            prompt: { type: "string", description: "下发给新会话的首轮任务文本——接力焦点，交接文档按其裁剪；工件路标（spec/tickets/map 等）写进这里" },
          },
          required: ["agent", "prompt"],
        },
        output: { type: "string" },
        async execute(input, tctx) {
          const sid = tctx?.sessionID
          // 工具入参按不可信载荷收窄（SDK 泛型面推断为宽形，运行时经 JSON Schema 校验）
          const agent = str(obj(input).agent).trim()
          const prompt = str(obj(input).prompt)
          if (!agent) {
            return { output: handoffResult("agent 不能为空（目标岗位 id）", 3, "") }
          }
          if (typeof sid !== "string" || !sid) {
            return { output: handoffResult("工具上下文缺少 sessionID", 2, agent) }
          }
          // 前置校验 agent（v0.27）：无效 → 3 态附清单，不建孤儿会话
          const names = await listAgentNames(ctx, io)
          if (names !== undefined && !names.includes(agent)) {
            return {
              output: handoffResult(
                `agent @${agent} 不在本项目 agent 清单（可用：${names.join("、")}）——agent id 须与注册名一致`,
                3,
                agent,
              ),
            }
          }
          // 主链：新会话 + 薄交接（create 级失败降级）
          try {
            const { s2, model, warning } = await handoffToFresh(io, ctx, sid, agent, prompt)
            // v0.29：回执随带实际落成的岗位模型（provider/model#variant）——分层是否
            // 生效一眼可核；岗无模型/降级时缺席（warning 注明沿用默认）
            const output = `handed off to @${agent}${model ? `(${model})` : ""}（新会话 ${s2}，原会话 ${sid} 已封箱——TUI 未自动跟随时可从会话列表切换）`
            return { output: warning ? `${output}\n⚠ ${warning}` : output }
          } catch (e) {
            console.log(`[auto-handoff] 主链失败（${errText(e)}），降级同会话切岗`)
            // 降级链：同会话切岗（switchAgent + prompt），记边界供 hook 保底裁剪
            try {
              const boundID = await lastMessageID(ctx, sid)
              if (boundID) fallbackBounds.set(sid, boundID)
            } catch {
              // 边界记录失败 → hook 不裁（仍可接力）
            }
            try {
              await ctx.session.switchAgent({ sessionID: sid, agent })
            } catch (e2) {
              console.log(`[auto-handoff] 同会话降级切岗失败：${errText(e2)}`)
              return { output: handoffResult(e2, 2, agent) }
            }
            try {
              await ctx.session.prompt({ sessionID: sid, text: prompt })
              return { output: `handed off to @${agent}（同会话降级：新会话不可用，已切岗、上下文按边界裁剪）` }
            } catch (e2) {
              console.log(`[auto-handoff] 同会话降级切岗成功但任务下发失败：${errText(e2)}`)
              return {
                output: `handed off to @${agent}（同会话降级：已切岗；⚠ 任务文本未发出（${errText(e2)}）——请在本会话直接再发一次任务文本）`,
              }
            }
          }
        },
      })
    })
    return () => {}
  },
})
