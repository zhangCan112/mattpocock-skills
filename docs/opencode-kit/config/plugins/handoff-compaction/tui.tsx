// handoff-compaction 插件 · TUI 部件 —— 会话右侧栏压缩状态栏（sidebar.content slot）
// 行一（压缩足迹）：Compacted N times (M failed) · last HH:MM · compacting…——数据源 =
//   transcript 的 type:"compaction" 消息（compactionTally / formatCompactionLine）。
// 行二（token 计费累计）：Total N tokens——数据源 = transcript 的 assistant 步 tokens
//   五字段累加（sessionTokensTotal / formatTokensLine），只增不减、压缩不重置的账单
//   口径（刻意区别于上下文水位：那是最后一次压缩后的最新 assistant 步，官方
//   lastAssistantWithUsage 口径，归水位线叙事不归本栏）。与 server 部件零耦合：不读
//   server storage（部件间 storage 命名域不保证共享，skill-trail 同款取舍），transcript
//   已含全部展示所需字段且跨 TUI 重启不丢。
// 两行各自缺席即不占行（无压缩痕迹只有 token 行、或反之，照常渲染；全空返回 null）。
// 摆位：prepend（slot 边界内首位）——skill-trail 走 append（边界内末位），两者分居
//   两端不依赖插件装载序，视觉上恒在其上方（同锚点多 claim 按 enable 序排，两端锚定
//   才是稳的）。已知取舍：若宿主在 sidebar.content 边界内还有原生内容，本栏会排在其
//   上——真机冒烟若觉突兀再议摆位。
// 纪律（skill-trail tui.tsx 同款）：零 solid-js/@opentui import（宿主运行时解析 JSX，
//   规避 peer 版本斜坡——TUI peer 类型不装，故 tsconfig include 不含本文件）；渲染全链
//   try/catch → null 降级（侧栏绝不因本插件崩）；无压缩痕迹返回 null 不占位。
// 已知取舍：数组渲染依赖宿主将 slot render 包进响应式计算（官方文档 "reactively"）；
//   message.list 是 solid store 读点，压缩事件到达自动重渲；message.sync fire-and-forget
//   拉新（首帧兜底）。
import { Plugin } from "@opencode/plugin/tui"
import { compactionTally, formatCompactionLine, formatTokensLine, sessionTokensTotal } from "./compaction.ts"

export default Plugin.define({
  id: "handoff-compaction.tui",
  setup(context: Plugin.Context) {
    try {
      return context.ui.slot({
        prepend: "sidebar.content",
        render: ({ sessionID }: { sessionID: string }) => {
          try {
            const data = context?.data
            if (!data?.session) return null
            try {
              void data.session.message.sync(sessionID).catch(() => {})
            } catch {
              // sync 不可用：靠已有缓存渲染
            }
            let messages: readonly unknown[] | undefined
            try {
              messages = data.session.message.list(sessionID)
            } catch {
              return null
            }
            const msgs = messages ?? []
            const compactionLine = formatCompactionLine(compactionTally(msgs))
            const tokenLine = formatTokensLine(sessionTokensTotal(msgs))
            if (!compactionLine && !tokenLine) return null
            const theme = context.theme ?? {}
            const base = theme.text?.base
            const muted = theme.text?.muted ?? theme.text?.dim
            return (
              <box>
                <text fg={muted}>── Compaction ──</text>
                {compactionLine ? <text fg={base}>{compactionLine}</text> : null}
                {tokenLine ? <text fg={base}>{tokenLine}</text> : null}
              </box>
            )
          } catch {
            return null
          }
        },
      })
    } catch {
      return undefined
    }
  },
})
