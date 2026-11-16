# 06 Misc 与 In-Progress：仓库的边缘地带

> 本文来源：`skills/misc/`、`skills/in-progress/` 下全部 11 个 SKILL.md 及配套脚本

这一章覆盖 11 个非主推 skill。它们不进插件、不上顶层 README，但看懂它们能帮你理解仓库的**生命周期设计**和"原语如何繁衍出变体"。

## 两个桶的定位差别（先说结论）

| | `misc/`（4 个） | `in-progress/`（7 个） |
|---|---|---|
| 一句话 | "留着但很少用"的小众工具 | 公开的 beta 试验场 |
| 官方措辞 | Tools I keep around but rarely use, not promoted in the plugin | Beta. Public on purpose: try them and tell me what breaks |
| 进插件？ | 否 | 否 |
| 有文档页？ | 否 | 否 |
| 稳定性 | 稳定，但无限期停泊 | **随时可能改动或消失** |
| 前途 | 无毕业机制 | 有：表现好就"毕业"进主推桶 |
| 调用方式 | 混合 | **全部 user-invoked**（beta 期不交给模型自主触发） |

生命周期上，`deprecated/README.md` 补了终点：退休的 skill **直接删除**，changeset 注明由什么取代。所以轨迹是 `in-progress →（毕业）→ 主推`，而不是移进 deprecated。

**贯穿观察**：in-progress 桶最鲜明的主题是 **"grilling 原语 × 具体领域"的试验田**——7 个里有 5 个是 grilling 的变体。misc 则是"没有后代、也不打算有"的工具箱角落，其中 3 个绑定作者自家生态（total-typescript / ai-hero），通用性低正是归入 misc 的直接原因。

---

## Misc（4 个）

### git-guardrails-claude-code — 危险 git 命令拦截器

**做什么**：给 Claude Code 装一个 PreToolUse hook，在危险 git 命令**执行前**拦截：`git push`（所有变体）、`git reset --hard`、`git clean -f`、`git branch -D`、`git checkout .`、`git restore .` 等。

**工作流程**：问作用域（本项目或全局）→ 复制捆绑的 `block-dangerous-git.sh` 到 `.claude/hooks/` → 在 settings 注册 hook（**合并进现有配置，不覆盖**）→ 按需增删拦截模式 → 用 `git push origin main` 做注入测试验证。

**为什么这样设计**：
- 脚本极简：stdin 读 JSON → `jq` 提取命令 → 对 9 个危险模式逐个 `grep`。核心是 **exit code 2 = Claude Code hook 的"拒绝执行"信号**
- 拦截消息归因于用户权威（"用户阻止了你"），而非伪装成技术错误
- 单独列出 `--force`、`reset --hard` 等模式，防非标准写法绕过

### migrate-to-shoehorn — 测试断言迁移器

**做什么**：把测试文件里的 `as` 类型断言迁移到 `@total-typescript/shoehorn`（作者自家的库）。**明确限定：只用于测试代码，绝不用于生产代码。**

**为什么**：测试中 `as` 有三个毛病——开发者被训练别用它、必须手写完整目标类型、故意传错数据要写丑陋的 `as unknown as Type`。shoehorn 三个函数各司其职：`fromPartial()` 传部分数据、`fromAny()` 传故意错误的数据且保留自动补全、`fromExact()` 强制完整对象。

**性质**：本质是一份**迁移模式目录**（知识型 skill），不是流程型 skill。绑定作者自家库是它归 misc 的直接原因。

### scaffold-exercises — 课程练习脚手架

**做什么**：为课程仓库创建能通过 `pnpm ai-hero-cli internal lint` 的练习目录（section / problem / solution / explainer）并提交。

**为什么**：手工搭骨架容易违反平台 lint 规则。设计上有两个细节：stub 时**默认建 `explainer/`**（不需要 TODO，最安全）；把 lint 规则**全文内联**进 skill，agent 不必猜平台约定。移动练习必须 `git mv` 保历史。绑定私有 CLI，通用性为零——典型的 misc。

### setup-pre-commit — 提交钩子安装器

**做什么**：装 Husky pre-commit hook：lint-staged 跑 Prettier + typecheck + test，把反馈回路前移到 commit 时刻。

**为什么**：
- 按 lockfile **探测**包管理器（npm/pnpm/yarn/bun），适配现状而非强推模板：没有的 script 就省略该行，只有缺 Prettier 配置时才创建
- 顺序刻意：lint-staged 先（快、只碰 staged 文件），全量 typecheck/test 后
- 最后以固定消息提交——**这次提交本身就是新 hook 的冒烟测试**

**历史地位**：它是仓库里 setup 类 skill 的**模板原型**——后面会看到 in-progress 的 `setup-ts-deep-modules` 完整复刻了它的骨架（探测环境 → 安装 → 写配置 → 接线 → 验证）。

---

## In-Progress（7 个）

### loop-me — 把生活模式变成自动化规格

**做什么**：在当前目录这个有状态工作区里对自己跑 grilling，产出**可实施的 workflow specs**。核心透镜：loop 是生活中反复出现的模式（职业、一周、早晨）；可预测正是**值得委托给自动化的理由**。skill 会主动提出用户自己没注意到的 loop。

**工作区**：`workflows/*.md`（每个 workflow 一份 spec，唯一事实源）+ `NOTES.md`（用户世界、工具、术语的原始笔记）。

**完成定义（Definition of Done）**：*一个 implementer agent 能不问任何问题就把它建出来。* 还有问题没解决就不算完。

**领域词汇**（不是 checklist，只在用得上时才够）：
- **Trigger**：触发，event 或 schedule（event 通常更高效）
- **Checkpoint**：human-in-the-loop 确认点；有些 workflow 一个都没有、有些根本不用 AI
- **Push right**：把 checkpoint 尽量往后推——先做最大化工作，让人类**只被问一次、问得晚、且一切已备好**
- **Brief**：checkpoint 呈现的紧凑摘要——直达资产链接，**永远不给原始输出**，"review 的速度是硬要求"

**设计哲学**：反过度设计宣言——"**不强制任何结构性东西**（mandate nothing structural）：grilling 没证明需要，workflow 就不该有 AI、checkpoint 或 schedule。"

**与主推的关系**：grilling 的直接领域化变体 + 复用 `teach` 的"当前目录作为有状态工作区"模式。

### 写作三部曲：fragments → shape / beats

in-progress 里最漂亮的一条流水线：把写作拆成 **explore（探索）→ exploit（利用）** 两相。

#### writing-fragments（explore）

**做什么**：跑一场 grilling 从你身上"采矿"出 fragments（异质写作碎块），**只追加**进单个 markdown 文件，完全不谈结构。"提交结构是 exploit，是另一个 skill 的事。"

**为什么**：
- fragment 门槛刻意很低："**作者自己读得懂**即可"，不需要自洽论证
- 刻意**异质**：金句、vignette、half-thought、引语、"凭感觉该待在一起"的观察簇、punchline 都算
- 最高价值目标是 **leading word**：能撑起整篇的紧凑造词（如 *tracer bullets*、*fog of war*）——"explore 阶段命名对了，它会塑造后面 exploit 阶段的结构、过渡和标题"。对话反复绕一个想法打转时，**推用户为它造词**
- 榜样是"小说家的日记"：多年不结构的 noticings，日后开采
- 写作纪律："**静默追加**"（不逐条请求许可）、每次写前**从磁盘重读**（用户可能改过）、只追加不覆盖

#### writing-shape（exploit，线性路线)

**做什么**：把固定的原料堆（fragments 文件、无结构散文、transcript 都行）**逐段**塑形成文章，每步为格式选择公开辩论。自称 "**a grilling session inverted**"：ideation 时问"你到底注意到了什么？"，现在问"这篇文章到底在论证什么？读者需要按什么顺序听到它？"

**核心机制 Grounding**：任何 concept 必须先被 grounded（读者进门就带，或在前面的 block 里见过）后面的 block 才能倚靠它。单位是 **concept 不是词**——没有 jargon 也能丢失读者。维护一份 running list："下一个动作需要的那个未 grounded 的概念，本身就是'读者下一步需要听什么'的答案。"

**结构决策**：起草 2–3 个候选 opening（各暗示不同 thesis），**逼用户选一个或拼 hybrid**——选定的 opening 定义了文章剩余部分必须做什么。

**格式辩论**（skill 内置）：prose vs list（论证 vs 并列）、table（同形状重复 3+ 次才上表）、quote（原话本身是重点才引用）、callout（只在真会岔开主线时用）……

**pile 是 quarry 不是 script**：fragment 可拆、可并、可改写；缺料时**点名缺口**："这里需要个例子而 pile 里没有。现在给我一个，否则砍掉这节。"

#### writing-beats（exploit，分岔路线）

**做什么**：与 shape 同一输入，但把文章塑造成一场 **beat 的旅程**，choose-your-own-adventure 风格：给 2–3 个候选 starting beats（先展示再写），用户选一个，**只写这一个 beat**，再给 2–3 个候选 next beats，循环直到自然收尾。

**机制本体**：**Grounding 决定了冒险分支图**——候选 beat 只有在其所需概念全部已 grounded 时才"可达"；选了一个 ground 出概念 X 的 beat，就解锁所有在等 X 的 beat。

**beat 的诊断标准**："如果一个'beat'要五段加三个小标题，它不是 beat，是两个 beat 粘在一起——拆开。"

**结束条件**："文章在**旅程完成**时结束，而不是 pile 掏空时"——剩料是常态，"这正是原料要比需要多的意义所在。"

### claude-handoff — 交接并直接拉起

**做什么**：主推 `handoff` 只写交接文档；这个变体**写完直接用 `claude --bg` 拉起一个后台 agent**，拿交接文档当它的 prompt，零空窗接手。

**为什么**：
- `--name` 强制带上（后台任务的可辨识性）
- **用 `cat` 传文件内容而非字符串内插，防 shell 执行 summary 里的反引号和 `$` 展开**——注入防护
- summary 要**脱敏**（API keys、密码、PII），因为它会成为对方 agent 的 prompt
- 与主推 handoff 共享几乎全部文档约定，唯一增量是"launch"这一步。绑 Claude Code 特有 CLI 能力，稳定性待验证，故 in-progress

### setup-ts-deep-modules — 用工具强制深模块

**做什么**：把 dependency-cruiser 接入 TypeScript 仓库，让每个 package 成为 deep module：**实现藏在子文件夹，只能通过根入口文件从外部触达**。这是"大泥球"失败模式的机械化防线。

**目录形状**：`src/packages/<name>/` 下根文件（`index.ts`、`client.ts`…）是 public 入口，`lib/`（实现）和 `tests/`（测试）是子文件夹故 private。

**规则设计**（为什么值得细读）：
- **Entry points, not a barrel**：公共面是*所有*根文件，不是单个巨型 `index.ts`——一个包可以暴露多个小入口
- **public/private 由"深度"决定**：根文件即入口、任何子文件夹皆私有——**新加文件夹永远不用改配置**
- 测试也只能走 entry points（**连自己包的 internals 都不行**），集成测试可跨包但不许 deep import
- 不动 tsconfig、不加 path aliases、已有配置则合并

**最点睛的一步**：第 6 步 "**Prove the rules bite（证明规则真会咬人）**"——干净跑必须 pass → 故意 deep import 一次必须 **fail** → 还原后必须再 pass。skill 原话："不会在违规时失败的配置一文不值。"

**与主推的关系**：原文显式要求 "call the Skill tool with **codebase-design**"，用它的词汇（deep module、interface、seam）贯穿全程——是主推设计词汇的**机器强制落地**。流程骨架复刻 `setup-pre-commit`；AGENTS.md 指针用 `writing-for-agents` 的 context pointer 概念（"这一行就是让 agent 发现边界规则、而不是一头撞上的关键"）。

### chief-of-staff — 常驻参谋长

**做什么**：在一个长运行 session 里扮演参谋长，协调 subagents 和 schedules 推进一个长期目标。角色设定："你是这个目标的 **Directly Responsible Individual**，被授权比你习惯的想得更长远。"

**双轨思考**：**Tactical**（怎么完成眼前任务）+ **Strategic**（怎么改造环境以改善*下一个*任务的产出）。

**纪律**：
- **所有工作都放进 subagents 做**（"Protect your context window"）
- 与 subagents 通信保持稀疏，主要靠 **context pointers**，不复制指针已可及的信息
- 做任何工作**之前先**考虑改善 agent 的环境
- **"no workarounds" 规则**：不允许绕过既有流程的一次性 hack；对约定的偏离必须在 feature work 之前主动修复

**环境哲学**：agent 在 **pit of success** 里才表现出色（极度受限的 API、强制正确性的 lint 规则、可供 reviewer 执法的 CODING_STANDARDS.md），还需要**数据源**（dev server 日志、测试数据库、浏览器）。态度要求："Be relentless in improving the environment. **Use every user message as an excuse to search for these improvements.**"

**与主推的关系**：subagent 纪律一段与 `implement-spec` 几乎逐字相同；它是 `retro` 的**持续、前置版本**——retro 事后回顾环境改进，chief-of-staff 把同样的意识变成每条用户消息都触发的常驻反射。

---

## 关系速查表

| skill | 与主推的关系 | 性质 |
|---|---|---|
| loop-me | grilling 领域化 + teach 的 stateful workspace | 变体 |
| writing-fragments | grilling 用于写作 explore | 变体 |
| writing-shape | grilling inverted 用于写作 exploit（线性） | 变体 |
| writing-beats | 与 shape 姊妹（共享 Grounding），分岔式 exploit | 姊妹实现 |
| claude-handoff | handoff + `claude --bg` 直接拉起 | 直接变体 |
| setup-ts-deep-modules | codebase-design 的机器强制落地 | 配套 |
| chief-of-staff | implement-spec 的 subagent 纪律 + retro 的常驻化 | 组合实验 |
| misc 四个 | 无主推亲属；个人生态或平台绑定 | 独立 |

## 上一章 / 下一章

- 上一章：[05-productivity篇.md](./05-productivity篇.md)
- 下一章：[07-工作流组合.md](./07-工作流组合.md)
