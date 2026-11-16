// skill-trail 插件 · TUI 部件 —— 会话右侧栏 skill 足迹视图（sidebar.content slot）
// 行格式：HH:MM skill名 (you/auto) [✗] [←触发情境≤16字符]——情境由 trail.ts 的
//   collectFromTranscript 从同一份 transcript 独立摘录（与 server 采集侧同语义、互不依赖）。
// 数据源 = transcript（持久权威，含 type:"skill" 消息与用户 part mention 标记），
//   会话家族（root+子代理）逐成员回填：data.session.family 归组，子会话以
//   SessionInfo 的 agent+title 标注触发者（同名 Agent 以 title 后缀消歧，
//   标签逻辑在 trail.ts 纯函数 memberLabel，node --test 直测）。server 部件的
//   storage 记录不在此读（部件间 storage 命名域不保证共享，不押注；transcript
//   已含全部展示所需字段）。
// 纪律：零 solid-js/@opentui import（宿主运行时解析 JSX，规避 peer 版本斜坡）；
//   渲染全链 try/catch → null 降级（侧栏绝不因本插件崩）；无记录时返回 null 不占位。
// 已知取舍：数组渲染依赖宿主将 slot render 包进响应式计算（官方文档 "reactively"）；
//   若实测不随事件刷新，升级路径 = solid-js <For>（需加 peer）。
import { Plugin } from "@opencode/plugin/tui"
import { collectFromTranscript, formatTrailLine, memberLabel } from "./trail.ts"

const MAX_LINES_PER_MEMBER = 8 // 长会话截尾，侧栏不被刷屏

export default Plugin.define({
  id: "skill-trail.tui",
  setup(context: Plugin.Context) {
    try {
      return context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }: { sessionID: string }) => {
          try {
            const data = context?.data
            if (!data?.session) return null
            const rootID = data.session.root(sessionID) || sessionID
            const family = data.session.family(sessionID) || [sessionID]
            // 家族成员数据拉取（fire-and-forget；store 响应式更新驱动重渲）
            for (const sid of family) {
              try {
                void data.session.sync(sid).catch(() => {})
                void data.session.message.sync(sid).catch(() => {})
              } catch {
                // sync 不可用：靠已有缓存渲染
              }
            }
            const groups: Array<{ label: string | null; lines: string[] }> = []
            for (const sid of family) {
              let messages: readonly unknown[] | undefined
              try {
                messages = data.session.message.list(sid)
              } catch {
                continue
              }
              const records = collectFromTranscript(messages ?? [])
              if (!records.length) continue
              groups.push({
                label: sid === rootID ? null : memberLabel(data.session.get(sid), sid),
                lines: records.slice(-MAX_LINES_PER_MEMBER).map(formatTrailLine),
              })
            }
            if (!groups.length) return null
            const theme = context.theme ?? {}
            const base = theme.text?.base
            const muted = theme.text?.muted ?? theme.text?.dim
            return (
              <box>
                <text fg={muted}>── skill footprint ──</text>
                {groups.map((g) => (
                  <box>
                    {g.label ? <text fg={muted}>▸ {g.label}</text> : null}
                    {g.lines.map((line) => (
                      <text fg={base}>{line}</text>
                    ))}
                  </box>
                ))}
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
