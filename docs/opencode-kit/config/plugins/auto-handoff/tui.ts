// auto-handoff 插件 · TUI 半 —— 接力会话自动跟随（v0.20，2026-11-01 第五轮定稿；
// v0.21 改名轮：luna-route → auto-handoff，「luna」前缀退役）
//
// 用户报「会话创建出来了，但他不会自动打开这个会话」。前四轮
// 四测全败的根因（第五轮实证）：**上一轮字节考古考错了二进制**
// （180MB 旧件 vs 实跑 253MB 宿主），据此写的「平铺单文件 + {id, tui(ctx)} 契约 +
// tui.json 声明面」在实跑宿主（@opencode/cli 2.2.1）上全部无效：
//   - 实跑宿主 TUI 插件发现 = 扫 `.opencode/plugins/` 下的**目录件**（平铺 .ts 文件
//     被静默跳过；tui.json 仅作全局一次性迁移源，项目级声明面不存在——冒烟
//     实证 plugins=16=14+2 目录件全部装载，平铺件恒不进 TUI 视野）；
//   - 模块契约 = default export `{id, setup(ctx)}`（SDK Plugin.define 形态；宿主
//     zDt 校验 + server 侧同契约报错串实证）。平铺旧件死在 server 装载校验
//     （「Plugin must export a default definition with an id and an effect or
//     setup function」，opencode.log role=server WARN，四轮均漏看）；
//   - ctx 面（配套 SDK @opencode/plugin 2.0.32 dist/tui/context.d.ts，与本宿主
//     同代）：data.on / data.session.get|list|sync / ui.tabs.focus / ui.router.
//     navigate({type:"session",sessionID}) / ui.toast.show / keymap.layer(
//     () => ({commands:[{palette:true, slash:{name}}]})) / client / location。
//
// 两半唯一契约不变：接力会话 title 前缀「接力 @」（auto-handoff.ts handoffToFresh
// 于 session.create({title}) 时同步设置——事件到达时记录已含 title；v0.27 去模型化轮
// 由「接力 /」改「接力 @」，两半同轮变更）。
// 判据取舍：title 特征识别而非 rpc 精确通知——撞名概率≈0，误导航仅切页可切回。
// 纪律：全链 try/catch 静默降级；命令面板 + /handoff 斜杠留手动逃生门（装载自证）。
// layer 必须声明 mode:"global"：面板/对话框 modal 模式下 base layer 不可达。
// 纯对象导出零依赖：不 import @opencode/plugin（校验只看 id+setup 字段，规避
// resolve 面与版本斜坡）。setup 返回清理函数（data.on 退订 + 挂起重试清零）。
//
// v0.28 接力链轮（2026-11-10 用户需求：右侧面板展示完整接力链、点击跳转；展示取
// 「一行一跳、只显示会话 title」简约定调）：纯逻辑抽 tui-core.ts（node --test 直测），
// 本件收窄为入口接线；接力链面板 chain-panel.tsx（JSX，@opentui/solid）由本件
// **动态装载**——渐进增强：面板装载失败只失面板（toast 告警），自动跟随/逃生门
// 不连坐。命令面板 + /handoff-chain 斜杠开面板（面板名 auto-handoff.chain）。

import {
  followSession,
  isRelaySession,
  latestRelaySession,
  listSessions,
  obj,
  sessionInfo,
  type TuiHost,
} from "./tui-core.ts"

export default {
  id: "auto-handoff-tui",
  setup(ctx: TuiHost) {
    const offs: Array<() => void> = []
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    // 自动跟随：session.created + title 特征 → 跟随 + toast
    try {
      const off = ctx?.data?.on?.("session.created", (event: unknown) => {
        void (async () => {
          try {
            const sid = obj(obj(event).data).sessionID
            if (typeof sid !== "string" || !sid) return
            // 跨 workspace 防误跟随：directory 不匹配则忽略；拿不到时仍跟随（单 workspace 主场景）
            const here = ctx?.location?.directory
            const there = obj(obj(event).location).directory
            if (typeof here === "string" && typeof there === "string" && here !== there) return
            const info = await sessionInfo(ctx, sid, (t) => (retryTimer = t))
            if (!isRelaySession(info)) return
            if (!followSession(ctx, sid)) return
            try {
              ctx.ui?.toast?.show?.({ title: "接力", message: `已切换到「${info.title}」`, variant: "info" })
            } catch {
              // toast 失败不影响跟随
            }
          } catch {
            // 单事件失败静默
          }
        })()
      })
      if (typeof off === "function") offs.push(off)
    } catch {
      // data 面不可用：只剩逃生门
    }

    // 逃生门 + 装载自证：命令面板 + /handoff 斜杠（keymap.layer，commands[].palette/slash）
    // mode:"global"（E17 实锤）：面板/对话框打开时宿主 push "modal" 模式、斜杠补全亦
    // 读 reachable 清单——未声明 mode 的 layer 回落 require base，在 modal 下不可达，
    // 命令静默从面板与补全消失（插件装载正常也看不见）。global = 无 mode require，
    // 永远可达（宿主自建 btw.tsx 同款，唯一官方样例）。
    try {
      ctx?.keymap?.layer?.(() => ({
        mode: "global",
        commands: [
          {
            id: "handoff.follow",
            title: "auto-handoff：跟随最近的接力会话",
            description: "切到最新的「接力 @」会话（TUI 未自动跟随时的逃生门）",
            group: "auto-handoff",
            palette: true,
            slash: { name: "handoff" },
            run: () => {
              void (async () => {
                try {
                  const latest = latestRelaySession(await listSessions(ctx))
                  if (!latest?.id) {
                    try {
                      ctx.ui?.toast?.show?.({ title: "接力", message: "没有接力会话", variant: "info" })
                    } catch {}
                    return
                  }
                  followSession(ctx, latest.id)
                } catch {
                  // 逃生门失败静默
                }
              })()
            },
          },
        ],
      }))
    } catch {
      // keymap 面不可用：自动跟随仍可能在工作
    }

    // 接力链面板（v0.28 渐进增强）：动态装载 chain-panel.tsx（JSX 半），失败不连坐。
    // 宿主面缺失（无 ui.slot，旧 TUI）→ 静默不装；模块装载失败（JSX 转译不可用）→
    // toast 告警（静默降级 ≠ 无声降级），自动跟随/逃生门照常。
    void (async () => {
      try {
        const mod = await import("./chain-panel.tsx")
        const off = mod.registerChainPanel(ctx)
        if (!off) return // 宿主无面板面：本宿主无此功能，不算故障
        offs.push(off)
        try {
          ctx?.keymap?.layer?.(() => ({
            mode: "global",
            commands: [
              {
                id: "auto-handoff.chain",
                title: "auto-handoff：接力链面板",
                description: "右侧面板展示当前会话的完整接力链，点击/回车跳转到链上会话",
                group: "auto-handoff",
                palette: true,
                slash: { name: "handoff-chain" },
                run: () => {
                  const opened = (() => {
                    try {
                      return ctx?.ui?.panel?.open?.(mod.CHAIN_PANEL_NAME)
                    } catch {
                      return false
                    }
                  })()
                  if (opened === false) {
                    try {
                      ctx.ui?.toast?.show?.({ title: "接力链", message: "请先进入一个会话再打开面板", variant: "info" })
                    } catch {}
                  }
                },
              },
            ],
          }))
        } catch {
          // 命令注册失败：面板仍可被其它插件/名字打开，不致命
        }
      } catch {
        try {
          ctx.ui?.toast?.show?.({ title: "接力链", message: "面板装载失败（自动跟随不受影响）", variant: "warning" })
        } catch {
          // toast 也不可用：全静默
        }
      }
    })()

    // 清理：退订事件 + 清挂起重试（keymap.layer 随插件停用自动移除，无需手清）
    return () => {
      for (const off of offs) {
        try {
          off()
        } catch {}
      }
      try {
        if (retryTimer !== undefined) clearTimeout(retryTimer)
      } catch {}
    }
  },
}
