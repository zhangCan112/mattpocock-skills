# SYNCED —— auto-handoff 全局安装快照

- **来源仓库**：`E:\opencode-plugins-v2`（分支 main）
- **来源 commit**：`23df038`（auto-handoff v0.29.0 岗位模型轮）
- **快照形态**：HEAD（工作区干净，无未提交修改）
- **同步方式**：`robocopy /MIR` 全量镜像（含 node_modules；本文件被 /MIR 删除后于镜像完成时重写）
- **同步时间**：2026-11-10 10:53（本地）
- **上一快照**：`4b72763`（v0.28.0）——本轮跨 v0.29 一轮

## 对版与现场诊断须知

- 本目录内容应与来源 commit `23df038` 逐字节一致（对版先看本文件，再看 `package.json` 的 `version`）。
- **v0.29 岗位模型轮**：`handoff_to` 建新会话时读目标岗 frontmatter `model`（agent 清单的
  `AgentInfo.model`）并显式落进 create——V2 语义下 primary 会话「选岗不改模型」，岗模型
  只对 subagent 生效，不显式落就吃用户上次手选默认（luna-app 实证 7 个 manager 主会话全
  落 glm-5.3#max 的根因）。回执带实际模型：`handed off to @agent(provider/model#variant)`。
  岗无 model / 模型不在宿主清单 / 带模型 create 失败 → 沿用默认并在回执 ⚠ 注明，接力不中断。
  同会话降级链（create 不可用时的 switchAgent）不切模型——用户会话模型归属用户手选。
- **v0.28 接力链**（仍有效）：`metadata["relay.parent"]` 记原会话 id，TUI 右侧接力链面板
  （`/handoff-chain`）走此链；v0.28 前的旧接力会话无链数据，面板会标注。
- **重同步后必须重启 opencode server**（watcher reload 不清 ESM 模块缓存——2026-11-03
  skill-trail「named export not found」WARN 潮实证，半新半旧组合会静默禁用插件）。本轮
  改了 handoff-core.ts / auto-handoff.ts，其他运行中的 opencode 进程（如 luna-app 会话）
  须各自重启才吃到 v0.29。
- 本目录为全局自动发现装载，勿在 opencode 配置里再以路径引用源仓库或本副本（双实例装载
  会致 TUI 弹 Plugin failed 横幅）。
- 修复只发生在源仓库（见源仓库 AGENTS.md 铁律）；本目录不做任何就地修改。
