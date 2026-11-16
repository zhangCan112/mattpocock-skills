// auto-handoff 插件 · 接力链面板（chain-panel.tsx）——v0.28 新增（2026-11-10 用户需求：
// 接力切换的 title 看不出接力链——右侧 session.panel 展示完整接力链，点击/回车跳转；
// 展示定调「简单文字：一行一跳、只显示会话 title」）。
//
// 宿主面（SDK @opencode/plugin 2.2.x dist/tui/context.d.ts + 官方 TUI 插件文档）：
//   - ui.slot({append:"session.panel", render}) 认领右侧会话面板；ui.panel.open(name)
//     选中内容名（本件 CHAIN_PANEL_NAME），host 管尺寸/焦点/全屏，插件管内容；
//   - 面板输入（SlotMap["session.panel"]）：name/sessionID/width/presentation/focused
//     （响应式 props）+ focus/close/toggleFullscreen 动作；
//   - JSX 走 @opentui/solid（宿主 import map 解析 "@opentui/solid/jsx-runtime" 与
//     "solid-js"——二进制字符串实证；tsconfig jsxImportSource 指向 @opentui/solid）；
//   - 鼠标：无合成 click 事件，左键 = onMouseUp 且 event.button === 0
//     （MouseButton.LEFT = 0）；行文本 selectable=false 防选择手势抢事件。
//
// 装载契约：本件由 tui.ts **动态 import**（渐进增强）——装载失败只失面板不连坐自动
// 跟随；registerChainPanel 返回清理函数（宿主无 ui.slot 面时返回 undefined，静默）。
// 数据源：tui-core.ts relayChain（metadata["relay.parent"] 走链；两半契约见彼头注）。
// 响应性防御：host 文档称 slot 输入为响应式，但有「slot 内容不随响应式更新」的已知
// issue 记录——本件除 Solid memo 外，另订阅 session.* 事件显式 bump tick 强制重算
// （重开面板亦重取快照，主路径不依赖响应性）。

import { createMemo, createSignal, onCleanup } from "solid-js"
import { followSession, obj, relayChain, str, type RelayChainRow, type RelaySession, type TuiHost } from "./tui-core.ts"

/** 面板名（ui.panel.open 的选中值；插件前缀防撞名——宿主文档规约） */
export const CHAIN_PANEL_NAME = "auto-handoff.chain"

/** session.panel 输入的最小结构视图（宿主边界：字段收窄使用，动作为可选成员） */
interface PanelView {
  readonly sessionID?: unknown
  readonly width?: unknown
  readonly focus?: () => void
  readonly close?: () => void
  readonly toggleFullscreen?: () => void
}

/** 认领右侧会话面板并渲染接力链；返回清理函数（slot 退订），宿主无面板面返回 undefined */
export function registerChainPanel(ctx: TuiHost): (() => void) | undefined {
  const slot = ctx?.ui?.slot
  if (typeof slot !== "function") return undefined
  try {
    const off = slot.call(ctx?.ui, {
      append: "session.panel",
      render: (panel: unknown) => (str(obj(panel).name) === CHAIN_PANEL_NAME ? <ChainPanel ctx={ctx} panel={asPanelView(panel)} /> : null),
    })
    return typeof off === "function" ? off : () => {}
  } catch {
    return undefined
  }
}

/** 收窄助手（Google TS 红线 ①：先视后用的单点断言——宿主面结构视图） */
function asPanelView(v: unknown): PanelView {
  return obj(v) as PanelView
}

function ChainPanel(p: { readonly ctx: TuiHost; readonly panel: PanelView }) {
  const ctx = p.ctx
  const [tick, setTick] = createSignal(0)
  const [cursor, setCursor] = createSignal(0)

  // 会话增删改名/链路变更 → bump 重算（防御 host slot 响应性缺口）
  const offs: Array<() => void> = []
  for (const evt of ["session.created", "session.deleted", "session.renamed", "session.metadata.updated"]) {
    try {
      const off = ctx?.data?.on?.(evt, () => setTick((t) => t + 1))
      if (typeof off === "function") offs.push(off)
    } catch {
      // 单事件订阅失败：其余照常
    }
  }

  const chain = createMemo(() => {
    void tick()
    const sid = str(p.panel.sessionID) // 响应式读：面板随会话切换重算
    const list = (() => {
      try {
        return ctx?.data?.session?.list?.() ?? []
      } catch {
        return [] as unknown[]
      }
    })()
    return relayChain(Array.isArray(list) ? list : [], sid)
  })
  const rows = createMemo(() => chain().rows)
  const idx = () => (rows().length ? Math.min(cursor(), rows().length - 1) : 0)
  const lineWidth = () => (typeof p.panel.width === "number" ? Math.max(12, Math.floor(p.panel.width) - 8) : 40)

  const jump = (info: RelaySession): void => {
    const sid = str(info.id)
    if (!sid) return
    if (!followSession(ctx, sid)) {
      try {
        ctx.ui?.toast?.show?.({ title: "接力链", message: "跳转失败：导航面不可用", variant: "error" })
      } catch {}
    }
  }
  const move = (delta: number): void => {
    const max = rows().length - 1
    if (max < 0) return
    setCursor(Math.max(0, Math.min(idx() + delta, max)))
  }

  // 键盘（面板拥有输入时激活；组件卸载即随 layer 处置——宿主 keymap 生命周期规约）
  try {
    ctx?.keymap?.layer?.(() => ({
      commands: [
        { bind: "up", run: () => move(-1) },
        { bind: "k", run: () => move(-1) },
        { bind: "down", run: () => move(1) },
        { bind: "j", run: () => move(1) },
        { bind: "enter", run: () => jump(rows()[idx()]?.session ?? {}) },
        { bind: "f", run: () => action(p.panel.toggleFullscreen) },
        { bind: "escape", run: () => action(p.panel.close) },
      ],
    }))
  } catch {
    // keymap 不可用：点击跳转仍可用
  }

  // 卸载清理：事件退订（keymap.layer 随组件/响应域销毁自动移除——宿主 keymap 生命周期规约）
  onCleanup(() => {
    for (const off of offs) {
      try {
        off()
      } catch {}
    }
  })

  return (
    <box style={{ flexDirection: "column", height: "100%", paddingX: 1 }}>
      <text fg="#f2f2f2" selectable={false}>接力链{rows().length > 0 ? ` · ${rows().length} 跳` : ""}</text>
      <box style={{ flexDirection: "column", paddingTop: 1 }}>
        {rows().length === 0 ? (
          <text fg="#7a7a7a" selectable={false}>当前会话暂无接力链</text>
        ) : (
          rows().map((row, i) => (
            <ChainRow
              row={row}
              selected={i === idx()}
              width={lineWidth()}
              onJump={jump}
            />
          ))
        )}
        {chain().legacy ? <text fg="#7a7a7a" selectable={false}>旧版接力会话：未记录链路（升级后的新接力会记录）</text> : null}
      </box>
      <box style={{ flexDirection: "row", marginTop: 1 }}>
        <text fg="#6a6a6a" selectable={false}>↑↓ 选择 · 回车/点击跳转 · f 全屏 · esc 关闭</text>
      </box>
    </box>
  )
}

function ChainRow(props: { readonly row: RelayChainRow; readonly selected: boolean; readonly width: number; readonly onJump: (info: RelaySession) => void }) {
  const title = str(props.row.session.title) || str(props.row.session.id)
  const brief = title.length > props.width ? title.slice(0, props.width - 1) + "…" : title
  const fg = props.row.isCurrent ? "#8cc5ff" : props.selected ? "#ffffff" : "#a0a0a0"
  return (
    <box
      style={{ flexDirection: "row" }}
      backgroundColor={props.selected ? "#3d3d3d" : undefined}
      onMouseUp={(e) => {
        if (e.button === 0) props.onJump(props.row.session) // 左键跳转（无合成 click：down/up 对判 button）
      }}
    >
      <text fg={props.selected ? "#ffffff" : "#5f5f5f"} selectable={false}>{` ${props.row.hop} `}</text>
      <text fg={fg} selectable={false}>{(props.row.isCurrent ? "▶ " : "") + brief}</text>
    </box>
  )
}

function action(fn: (() => void) | undefined): void {
  try {
    fn?.()
  } catch {
    // 动作失败静默
  }
}
