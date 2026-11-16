# OpenCode Luna 环境安装包 — AI 安装说明

> 本文档写给**在新设备上执行安装的 AI 助手**。请按顺序完整执行，每步的验证过了再走下一步。
> 包内一切路径以本包根目录（下称 `$KIT`）为基准。

## 0. 这是什么

本包是「power-luna」opencode 工作环境的完整离线安装件，在源机器（Windows）上从真实运行环境原样复制组装：

| 组成 | 内容 | 版本/数量 |
| --- | --- | --- |
| 主环境配置 | 全局 opencode 配置（provider 白名单、子 Agent 模型、压缩策略、CLI 偏好、水位线） | — |
| auto-handoff 插件 | 跨会话接力工具 `handoff_to` + 接力链面板 | v0.29.0 |
| handoff-compaction 插件 | 六段 handoff 摘要替代压缩保留尾巴；smart-zone 绝对线自动压缩 | v0.23.0 |
| skill-trail 插件 | 侧栏技能激活时间线 + 审计轨迹 | v0.6.0 |
| relay 插件 | relay 守护进程自动拉起 + MCP 注册（跨会话/跨岗通信，含内置 daemon.py） | v0.2.0 |
| power-luna 插件 | 岗位工厂（/agent-creator 造岗改岗撤岗 + 工人契约 skill） | v0.1.0 |
| 技能库 | 全部 agent 技能（pinpoint 评审回路、tdd、code-review、wayfinder、grilling 等） | 47 个 |
| 项目模板 | my-craft-demo 组织蓝图 + 岗位定义（`template\.opencode`，新建项目时复制进项目根） | 15 岗位 |

模型体系（源机原样）：主会话 **GLM-5.3**（provider `zhipuai-coding-plan`），干活型子 Agent 用 `glm-5.3-flash#max`，模板内岗位各自声明模型变体。**新设备若换用其他模型，必做 §3.6 的替换步骤**——白名单不改会把新模型锁死。

## 1. 包结构 → 目标路径

```
$KIT\
├── INSTALL.md                ← 本文档
├── config\                   ← → ~/.config/opencode/        （全局 opencode 配置）
│   ├── opencode.jsonc        ← 主配置（agents 模型 / provider policies / compaction）
│   ├── cli.json              ← 终端 UI 偏好
│   ├── models.json           ← 全局水位线（smart_zone_tokens: 180000）
│   ├── package.json / package-lock.json / bun.lock   ← @opencode/plugin 2.0.32 依赖声明
│   └── plugins\              ← 五个插件源码 → ~/.config/opencode/plugins/
│       ├── auto-handoff\
│       ├── handoff-compaction\
│       ├── power-luna\
│       ├── relay\            ←（内含 relay\daemon.py，自包含，无需 npm 依赖）
│       └── skill-trail\
├── dot-agents\               ← → ~/.agents/                 （用户级技能目录）
│   ├── .skill-lock.json      ← 技能来源锁文件
│   └── skills\               ← 47 个技能目录（含 pinpoint 的 scripts/ 回路脚本）
└── template\
    └── .opencode\            ← 默认项目模板（新项目时整目录复制进项目根，见 §6）
        ├── agents\           ← 15 个岗位定义（frontmatter 含 model/permission）
        ├── models.json       ←（implement-engineer 岗水位线 500000）
        ├── opencode.json     ←（subagent_depth: 2）
        └── power-luna\
            ├── blueprint.json / org.json   ← 组织编制蓝图
            └── feedback\ retro\ review\    ← 运行时落盘目录（空，自带 README）
```

Windows 上 `~` = `%USERPROFILE%`（即 `C:\Users\<用户名>\...`）。opencode 在 Windows 同样使用 `%USERPROFILE%\.config\opencode` 与 `%USERPROFILE%\.agents`，与 Linux/macOS 的 `~/.config`、`~/.agents` 同构。

## 2. 前置条件（先逐项检查，缺的先装/先问用户）

| 依赖 | 检查命令 | 用途 | 缺失后果 |
| --- | --- | --- | --- |
| opencode v2 | `opencode --version` | 本体 | 无法工作；安装指引见 https://opencode.ai/docs/ |
| Node.js ≥ 20 + npm | `node -v && npm -v` | 插件依赖安装 | 插件装载失败 |
| Python ≥ 3.10 | `python --version`（Windows）／`python3 --version`（Unix） | relay 守护进程、pinpoint 回路脚本 | relay/评审回路不可用 |
| uv | `uv --version` | code-review-graph MCP（`uvx code-review-graph serve`，可选——模板未携带其配置，项目要用再装） | 该图谱 MCP 不可用 |
| Git | `git --version` | 项目版本控制 | 模板工程退化 |
| 目标 provider / 模型 | **问用户**：新设备沿用智谱 GLM，还是换模型？ | 决定 §3.6 是否执行、改哪些地方 | 不问就装 → 白名单锁死或岗位模型失效 |
| 网络 | — | 仅 `npm install` 拉 `@opencode/plugin` 需要联网，其余全部离线可用 | 见 §7 离线预案 |

## 3. 安装步骤

### 3.0 停服务
若目标机 opencode 正在运行（TUI/服务）：`opencode service stop`。装完统一 `restart`。

### 3.1 备份
若 `~/.config/opencode/` 或 `~/.agents/` 已有内容（非全新设备），先整体备份一份（如 `~/.config/opencode.bak-<日期>/`）。本包文件会覆盖同名文件。

### 3.2 装全局配置
把 `$KIT\config\` 下的 **6 个文件**（opencode.jsonc、cli.json、models.json、package.json、package-lock.json、bun.lock）复制到 `~/.config/opencode/`。

注意：
- **不要**复制出 `service.json`——包里本来就没有（它是本机服务密码件，由 opencode 自动生成，见 §7）。
- 若目标机已有自己的 `opencode.jsonc` 且用户想保留某些字段，做字段级合并而非整文件覆盖；本包配置的关键字段：`agents.general.model`、`policies`（provider 白名单，只放行 `zhipuai-coding-plan`）、`compaction.keep.tokens: 0`（六段摘要替代保留尾巴的开关）。

### 3.3 装插件
把 `$KIT\config\plugins\` 下的 **5 个插件目录**复制到 `~/.config/opencode/plugins/`（没有就建）。

铁律（源机房规）：
- 配置目录 `plugins/` 下的插件包**自动发现装载**。**禁止**再在 `opencode.jsonc` 的 `plugins` 字段里以路径引用这些目录或任何源仓库副本——双实例装载会导致 TUI 报 Plugin failed 横幅。
- 装完必须 `opencode service restart`（watcher 热载不清 ESM 模块缓存，半新半旧组合会静默禁用插件）。

### 3.4 装插件依赖
在 `~/.config/opencode/` 下执行 `npm install`（有 lockfile，会装 `@opencode/plugin@2.0.32` 到配置根 `node_modules`，5 个插件统一向它解析；用 bun 的话 `bun install` 亦可，二选一）。

插件自带的 `package.json` 里声明的运行依赖只有 `@opencode/plugin` 这一个，根目录装完即全部就绪。**预期不需要**在各插件目录内单独 `npm install`（源机里 auto-handoff/skill-trail 携带的庞大 node_modules 只是开发期 typecheck/test 的遗留镜像，运行时不解析）。万一某插件装载报模块缺失，再进该插件目录 `npm install` 兜底。

### 3.5 装技能库
- `$KIT\dot-agents\skills\` → `~/.agents/skills/`（整目录复制）
- `$KIT\dot-agents\.skill-lock.json` → `~/.agents/.skill-lock.json`

若目标机 `~/.agents/skills/` 已有别的技能，按目录名合并：同名目录以本包版本覆盖前先备份；异名目录保留。

### 3.6 模型替换（新设备换用非智谱模型时必做；沿用 GLM 则跳过本节）

本包一切模型配置以 `zhipuai-coding-plan`（GLM-5.3 系）为准，且全局 `policies` 把**其他 provider 全部 deny**——换模型不改配置会直接锁死环境。先问用户「新设备用哪个 provider / 哪个模型」，然后改三处：

1. **全局配置** `~/.config/opencode/opencode.jsonc`：
   - `agents.general.model`（干活型子 Agent 的模型）→ 改成新模型，或整段删除让它继承会话默认；
   - `policies` 两条：把 allow 那条的 `resource` 换成新 provider id；或干脆删掉整个 `policies` 数组（放开全部 provider，回到默认行为）。
2. **模板岗位定义** `$KIT\template\.opencode\agents\*.md`（15 个文件 frontmatter 都有 `model: zhipuai-coding-plan/glm-5.3-flash#…`）。两种改法：
   - 推荐：整行删掉 `model:` 行，岗位继承会话默认模型（变体后缀 `#high/#max` 是 GLM 特有推理档位，换家无意义）：
     ```powershell
     Get-ChildItem "$KIT\template\.opencode\agents\*.md" | ForEach-Object {
       (Get-Content $_ -Raw) -replace '(?m)^model:\s*\S+\r?\n', '' | Set-Content $_ -NoNewline -Encoding UTF8
     }
     ```
     bash 等价：`sed -i '/^model: zhipuai-coding-plan\//d' "$KIT/template/.opencode/agents/"*.md`
   - 或统一替换成新模型（保留按岗配模型的口子）：
     ```powershell
     $new = 'anthropic/claude-sonnet-4-5'   # ← 换成实际 provider/model
     Get-ChildItem "$KIT\template\.opencode\agents\*.md" | ForEach-Object {
       (Get-Content $_ -Raw) -replace 'model: zhipuai-coding-plan/\S+', "model: $new" | Set-Content $_ -NoNewline -Encoding UTF8
     }
     ```
3. **水位线**：全局 `models.json` 的 `smart_zone_tokens: 180000` 与模板 `.opencode/models.json` 的 `implement-engineer: 500000` 都按 GLM 1M 窗口调的。新模型窗口更小必须下调（经验值：窗口的 75–90%，如 200k 窗口配 150k、128k 配 100k），否则自动压缩永不触发；拿不准可删数值走内置 150k 兜底（128k 以下窗口仍需手动调低）。

### 3.7 重启并认证
1. `opencode service restart`
2. 认证 provider（**需要用户本人操作，API key 不在包内**）：让用户运行 `opencode auth login`，选择目标 provider（沿用本包默认即 `zhipuai-coding-plan`/智谱；做过 §3.6 替换就选新 provider），粘贴自己的 API key。没有 key 就先问用户要，别跳过——白名单只放行那一家，不认证等于全环境不可用。

## 4. 验证清单（逐条过）

1. `opencode service status` 正常；`opencode api get /api/info` 有响应。
2. 起一个会话，模型选本环境的目标模型（未做替换即 `zhipuai-coding-plan/glm-5.3`），发一句话能回。
3. 插件装载验证：
   - `handoff_to` 工具可用（auto-handoff）；
   - relay 守护自动拉起：状态目录 `~/.relay/` 出现 lock.json，`tools.relay.*`（ask_user/open_line/send/list_lines）可用；
   - 压缩插件生效标志：`~/.config/opencode/models.json` 的 `smart_zone_tokens: 180000`，长会话过线时触发六段 handoff 摘要（不必当场验证，知道判据即可）。
4. 技能装载：会话里可见技能清单（47 个目录），抽查 `pinpoint`、`tdd`、`wayfinder` 在列。
5. 有装载错误看日志：`~/.local/share/opencode/log/opencode.log`（过滤 `role=server`）。

## 5. 组件速写（给新设备 AI 的行为说明）

- **relay**：一个全局守护进程服务所有工作区（`~/.relay`，可用 `RELAY_HOME` 改）；插件在 server 启动/重载时探活、拉起并以 MCP 注册。`ask_user` 是对用户的阻塞式提问通道；`open_line`/`send` 是对 peer 会话的点对点通道。传输层报错（如 ECONNRESET）多半是守护重启过：探活后原样重发即可，不当业务失败。
- **压缩策略**：`compaction.keep.tokens: 0` + 六段 handoff 摘要是有意设计——压缩后窗口只装摘要，不留原文尾巴。**别**自作主张加回 keep 配置。
- **provider 白名单**：`policies` 全局禁用了除 `zhipuai-coding-plan` 外的一切 provider，项目级配置无法翻案，这是源机的有意设计。新设备换模型先过 §3.6，别把旧白名单原样带过去。
- **pinpoint 回路**（源机工作区规则）：设计稿/研究结论等需用户裁决的内容 render 成 pinpoint 页 → 给 URL → 挂起等批注 → Apply 后改 master。脚本在 `~/.agents/skills/pinpoint/scripts/`（python）。

## 6. 模板使用（新建项目）

新开项目时把 `$KIT\template\.opencode\` 整目录复制到新项目根（成为 `<项目>\.opencode\`）：

- **组织编制**：`.opencode/power-luna/blueprint.json`（岗位+汇报线+主/子模式）与 `org.json`（编制清单与边）是组织蓝图；`.opencode/agents/` 下 15 个 `.md` 是对应岗位的 opencode Agent 定义（frontmatter 含 `model` 与 `permission`）。改编制 = 改这几处。
- **岗位模型**：各岗 frontmatter 各自声明模型变体（如 scrum-master 用 `glm-5.3-flash#high`）；`handoff_to` 接力时会读取并应用。
- **项目级配置**：`.opencode/opencode.json`（subagent_depth: 2）与 `.opencode/models.json`（implement-engineer 岗水位线 500000）随模板带走。
- **可选**：项目要用 code-review-graph 图谱 MCP 时，自行在项目 `opencode.jsonc` 配 `"mcp": {"code-review-graph": {"type": "local", "command": ["uvx", "code-review-graph", "serve"]}}`（需 uv），进项目后先全量建图（`build_or_update_graph_tool({ repo_root: <项目绝对路径>, full_rebuild: true })`），图谱 DB 落在项目内 `.code-review-graph/`（记得 gitignore）。
- 模板只含「蓝图 + Agents + 项目级配置」；AGENTS.md、docs、源码等由新项目自建。

## 7. 安全与排除项（源机已刻意不入包）

| 排除项 | 原因 |
| --- | --- |
| `service.json`（服务密码）、auth/API key | 本机敏感件；目标机由 opencode 自动再生 / 用户自行 `auth login` |
| 全部 `node_modules` | 体积（~500MB）；`npm install` 按锁文件重建 |
| `.git`、运行时数据（`~/.relay`、feedback/retro/review 内容、图谱 DB） | 机器/项目本地状态 |
| 模板的工程文件（AGENTS.md、docs、源码、`opencode.jsonc`） | 模板只含「蓝图 + Agents + 项目级配置」，工程内容新项目自建 |
| 源仓库（opencode-plugins-v2 等） | 插件修复只发生在源仓库；本包是安装件快照。要更新版本需回源机重新导出 |

**离线预案**：若目标机装 `@opencode/plugin` 时无网络——从任一台已装 opencode v2 的机器把 `~/.config/opencode/node_modules/@opencode` 整目录拷到目标机同位置即可。

## 8. 故障排查

| 症状 | 处置 |
| --- | --- |
| TUI 报 Plugin failed 横幅 | 多半双实例装载：查 `opencode.jsonc` 是否有人把插件路径写进了 `plugins` 字段，删掉引用，`service restart` |
| 插件静默不生效 | watcher 热载不清 ESM 缓存：`opencode service restart`；日志确认装载 |
| relay 工具不可用 / 连接失败 | 查 `~/.relay/` 是否生成、`python` 是否在 PATH；传输错误先探活重发 |
| 模型/_provider 不可用 | 确认 `opencode auth login` 完成；白名单只认 `zhipuai-coding-plan` |
| code-review-graph MCP 起不来 | `uv` 未装或离线缓存缺失：`uv tool install code-review-graph` 预装一次 |
| 覆盖安装后行为诡异 | 先 `service restart`；仍怪则比对 `package.json` 版本与本表快照是否被改动 |

— 快照信息：组装于 2026-11-16，源机 Windows，插件快照 commit 参考（auto-handoff v0.29.0 ← `23df038`，源仓库 `E:\opencode-plugins-v2`）。装完把异常与偏差回报给用户即可。
