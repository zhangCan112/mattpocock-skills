# SYNCED.md — 部署指纹

- 来源仓库：`E:\opencode-plugins-v2`（分支 main）
- 来源 commit：`3a8c83b`（= 同步时 HEAD，工作树干净，无未提交修改）
- 版本：**0.23.0**（按 Agent / 按模型配线——六档链：项目 `agents.<name>` > 项目 models
  匹配池 > 项目 active 兜底 > 全局 models 匹配池 > 全局 active 兜底 > 内置缺省 150k。
  动因：用户要「每个模型一条自己的绝对线」（原话链「项目 agent > 按模型 > 兜底配置 >
  全局模型配置 > 全局兜底配置 > plugin 硬编码默认值」）——全局 180k 下 200k 窗口模型
  宿主 15% 兜底（170k）先于插件线，按模型配线后所有窗口都可让插件先压）
- 同步方式：`robocopy /MIR /XD node_modules`（2026-11-05；退出码 3 = 拷贝成功 +
  /MIR 清掉上一份 SYNCED.md，随后本文件重写——非错误）
- 同步后必须**重启 opencode server + 重开 TUI**——ESM 模块缓存，watcher reload 不清
  缓存，半新半旧组合会以 named export not found 静默禁用插件（v0.5.0 事故教训）。本件含
  TUI 部件，server 重启之外 TUI 侧也要重开才能装载。
- 全局 models.json 落地形态（本机 `C:\Users\user\.config\opencode\models.json`）：
  `{"active":"main","profiles":{"main":{"smart_zone_tokens":180000}}}` —— 全局兜底 180k。
  要按模型配线加匹配池即可，如 `"glm-1m": { "models": ["zhipuai/glm-5.3"],
  "smart_zone_tokens": 200000 }`；项目内按 Agent 配线放项目 `.opencode/models.json`
  的 `"agents": { "explore": { "smart_zone_tokens": 60000 } }`（agents 是项目层专属键）。
- 运行时对版（唯一可靠）：开 `HANDOFF_COMPACTION_PROBE=1` 的会话探针 JSONL 里——
  **v0.23.0 特征**：threshold 探针带 `source:"project"|"global"|"default"` +
  `matched:"agent"|"model"|"active"`（"disk" 已并入 "project"；percent 探针也带 matched）；
  中途换模型 / 换岗后同会话 line 跟着变。其余特征同 v0.21+：step.ended 事件线带
  used/peak/line/fire；过线后当步即 `trigger` `outcome:"triggered"`；hook 基线结局
  tookover/degraded、完结态 `final:"spliced"`；Esc 之后过线 `skip-cancelled`。
- **配套宿主配置（不变）**：全局 `opencode.jsonc` 只配 `keep.tokens: 0`，buffer 不配
  （吃缺省 15% 兜底；各模型的插件线自配后自然先压）。
- v0.23.0 语义速查：身份源 = session.get 的 agent?/model?（逐事件取，中途切换即时换线）；
  缓存键 cwd|模型|agent，任一身份变化即重解析；全链落空不缓存（修好任一层文件下个事件
  即生效）。已知取舍（用户知情）：①身份逐事件拉取（每 step.ended 一次 session.get，
  百分比形态本就如此）；②agents 全局层不读（项目层专属）；③worker 档维持 active 单源。
  触发语义同 v0.21.0：过线的 step 一结算就发起，滞回 / in-flight 防抖 / 底座护栏 /
  再武装 / Esc 取消全部保留。
- 版本沿革：0.6.0 缺省线回调 150k(§11)；0.7.0 defer-until-settled(§12)；0.8.0 keep 归零
  理念；0.10.0 TUI 压缩状态栏；0.13.0 TUI 文案英文；0.16.0 用户中断取消(§15)；0.17.0
  完结态终答原文保全(§16)；0.18.0 口吻受众回退 Matt 原味(§17)；0.20.0 回退 v0.19、
  触发层原样回归(§19)；0.21.0 defer-until-settled 整层拆除、过线即压(§20)；0.22.0
  models.json 全局层、键级回落、项目覆盖全局(§21)；**0.23.0 按 Agent / 按模型配线、
  六档链(§22)**。
