# 04 Engineering 篇（下）：9 个模型调用 skill

> 本文来源：`skills/engineering/` 下 9 个 model-invoked skill 的 SKILL.md 与配套文件（LOGIC.md、tests.md、mocking.md、DEEPENING.md、DESIGN-IT-TWICE.md、template.sh 等）

这 9 个 skill 是被上层 user-invoked skill 当**积木**调用的"纪律承载者"。它们呈三种形态：

- **流程驱动型**：prototype、diagnosing-bugs、research、code-review、wizard
- **循环参考型**：tdd
- **词汇参考型**：codebase-design、domain-modeling、pr

---

## prototype — 用可抛弃代码回答一个设计问题

**定位**：throwaway（可抛弃）代码回答**一个**设计问题。问题先行：问题决定原型的形态，产物永远不进 main branch。

**解决什么**：两种"讨论解决不了"的失败——① 状态模型/业务逻辑"纸上看着对，跑起来才觉得不对"（grilling 会话在这种问题上越拖越大）；② UI 长什么样无法凭空想象（用户"在脑子里三个模糊 mockup 之间挑一天"）。

**工作流程**：第 0 步先识别问题类型，选分支：

**LOGIC 分支**（"这个 state model 对不对？"）→ 单一可分享 HTML 文件：
1. 问题写在 demo 顶部可见处（不是注释）
2. 逻辑隔离成 portable module（reducer / state machine / 纯函数集），**无 DOM 依赖**，页面调用它、它不依赖页面
3. 单文件、无框架、双击即开、邮件转发后仍能跑——布局：当前 state 面板 + **free-play buttons**（任意乱按）+ **tabbed guided walkthroughs**（每 tab 一个 scenario，专挑纸上难推理的尴尬 case）
4. 交付给非开发者（designer/PM/领域专家）——关键反馈是 *"wait, that shouldn't be possible"*：那是**想法里的 bug**，正是原型目的
5. 验证过的逻辑模块 lift 进真实代码；HTML 壳进 throwaway branch

**UI 分支**（"这该长什么样？"）→ 同一路由上 **3–5 个结构性不同的 variant**：
- 强烈偏好挂在已有页面上用 `?variant=` 切换（保留真实 header/sidebar/数据/密度——"真空里的 variant 个个看着都行"）；新建 throwaway route 是最后手段
- **结构性不同**（不同布局、信息层级、主要 affordance）："三个微调过的 card grid 是 wallpaper 不是原型"
- floating bottom bar 切换器：箭头循环、写回 URL（可分享）、production build 里隐藏
- 典型反馈："B 的 header 配 C 的 sidebar"——这才是真正的设计

**为什么这样设计**：
- **throwaway 是对写法的约束**，不是销毁承诺——不写测试/错误处理/抽象，因为 none of that 帮你学到要学的那一件事。"当你开始给原型加测试、接真库，你已经不在 prototype 了"
- **为什么单 HTML 而不是 terminal app**（docs 记载的演进）：terminal app 要求 clone + 装 runtime，排除了最需要给意见的人
- **为什么不删而是存 branch**：原型是 **primary source**——"下一个 session 接手的人拿什么工作？"prose 总结丢掉了让原型有说服力的东西；但它没人维护、会 stale，所以不进 main、永不 merge
- 明确反对"全应用原型"：没有天然停止点，会漂移成 production app

**被谁调用**：wayfinder（四种 decision ticket 之一）、ask-matt（主流程第 2 步 detour，经 `/handoff` 桥接）；grill 家族处理"可 grill"的问题，不可 grill 的来这。

---

## diagnosing-bugs — 六阶段门控式诊断循环

**定位**：硬 bug 与性能回归的纪律循环。核心律令：**没有能对这个 bug 变红（red-capable）的 tight feedback loop，禁止形成任何理论**。

**解决什么**："拿到 bug report，coding agent 的默认行为是**读代码然后猜**"——这个 skill 专门阻断这个失败模式。适用：第一眼看不出答案的 bug、intermittent flake、两个已知良好状态之间的 regression。

**六阶段**（每阶段有进入门控）：

1. **Build a feedback loop——"This is the skill"**。不成比例的努力花在这里（"Be aggressive. Be creative. Refuse to give up."）。构造手段按偏好排序 10 种：failing test → curl 脚本 → CLI diff 快照 → headless browser → replay trace → throwaway harness → property/fuzz loop → `git bisect run` harness → differential loop → **HITL bash 脚本**（最后手段，用捆绑模板驱动人类按 Enter）。然后 **tighten the loop**：更快（秒级）、信号更锐（断言精确 symptom）、更确定（pin time、seed RNG）。"30 秒 flaky loop 只比没有好一点点；2 秒 deterministic loop 是 debugging superpower。" 完成判据：能点名**一条命令**、已跑过至少一次、Red-capable / Deterministic / Fast / Agent-runnable 四个 checkbox 全过。**"No red-capable command, no Phase 2."**
2. **Reproduce + minimise**。确认失败模式是**用户描述的那个**（wrong bug = wrong fix）；逐项删输入/配置/步骤，每次删后重跑，只留 load-bearing 元素——最小化既缩小假设空间，又成为 Phase 5 的 regression test。
3. **Hypothesise**。先生成 **3–5 个排序假设**（对抗"第一个合理想法即答案"的锚定）；每个必须 **falsifiable**："若 X 是原因，则改 Y 会让 bug 消失"。说不出预测的 hypothesis 是 vibe，丢弃。
4. **Instrument**。每个 probe 对应一个具体预测，**一次只改一个变量**。debugger > targeted logs > 绝不 "log everything and grep"。每条 debug log 打唯一前缀 tag（如 `[DEBUG-a4f2]`）——收尾清理变成一次 grep。**Perf 分支**：先建 baseline 测量再 bisect，**measure first, fix second**。
5. **Fix + regression test**。先写 regression test 再修，但仅在存在 **correct seam** 时——测试要在真实调用场景下练习真实 bug pattern；seam 太浅的测试给虚假信心。**若无 correct seam，这本身就是 finding**：架构阻止了这个 bug 被 lock down，记录并标记（交给 improve-codebase-architecture）。
6. **Cleanup**。重跑 Phase 1 loop 确认不再复现；grep 确认插桩移除；**commit message 里写明哪个 hypothesis 是对的**——让下一个 debug 的人学习。

**为什么这样设计**：
- "Loop 即 skill，其余都是机械的"——"Build the right feedback loop, and the bug is 90% fixed"
- **门控而非 checklist**：每阶段进入条件为真才能进，这是整个 skill 存在的意义
- 全程 **Redact 原则**：展示的命令/输出先脱敏，loop 建在 env vars 上

**被谁调用**：无 user-invoked 直接调用；ask-matt 把"东西坏了"路由到这里；修完同 session 跑 `/retro` 问"什么本可预防此 bug"。

---

## research — 后台代理的一手资料调查

**定位**：把问题委托给 **background agent**，只依据高信任 primary sources 调查，产出**每条 claim 带引用**的 Markdown 文件存进仓库——你继续干活，它在读。

**解决什么**：① "下一步是从工作目录之外找出某个事实"（第三方 API 行为、spec 说了什么）时，主线程不想停下来做阅读打杂；② 对抗 LLM 研究两大病——**转述二手来源**（博客怎么讲 API，而不是 API 自己的 docs）、**答案消失在会话里**。

**工作流程**（整个 SKILL.md 只有三步，核心是委托结构）：
1. Spin up 一个 background agent，主会话继续工作（"If you are sitting watching it read, the delegation didn't happen"）
2. 后台 agent 只读 **primary sources**（官方文档、源代码、specs、第一方 APIs），把每条 claim 追溯到拥有它的来源
3. 产出到仓库里的**单一 Markdown 文件**，遵循仓库既有存放约定

**为什么这样设计**：
- **为什么后台跑**：主会话 context 保持干净；research 是"你委托的 legwork，不是你外包的思考"——文件回来后**决策仍由你做**
- **为什么强制 primary source + 逐条引用**：这是对"五个 subagent 指向垃圾来源只会更快地给你五个自信的错误答案"这一质疑的唯一防线——引用让你可以抽查两三条即可验伪
- **与 ADR 的分界**：看产出的**保质期**——research 产出短命事实（本周这库的 auth 机制如何），ADR 记录你要保留的决策
- 已知缺陷（docs 坦承）：后台 agent 可能嵌套 spawn（单任务曾烧 ~450k tokens）；无停止判据——要给**窄问题**

**被谁调用**：wayfinder 是唯一直接调用者（research ticket，charting 时每张并行 fire 一个）；产出文件是 `/grill-with-docs` 的输入。

---

## tdd — 红绿循环的参考规范

**定位**：red → green 循环的**参考规范**（reference，不是 driver）：定义什么是好测试、测试住在哪（seams）、三大 anti-pattern、循环规则。

**解决什么**：三大让测试套件一文不值的失败模式（SKILL.md 明列）：

1. **Implementation-coupled**：mock 内部 collaborator、测私有方法、通过旁路验证（查 DB 而非用接口）——征兆：**重构时行为没变测试却红了**
2. **Tautological**：断言的期望值用代码自己的方式重算（`expect(add(a,b)).toBe(a+b)`）——构造上必然通过；期望值必须来自独立 truth（字面量、worked example、spec）
3. **Horizontal slicing**：先写全部测试再写全部实现——批量测试验证的是**想象中的行为**

**工作流程**：
- **Seams 约定**：seam = 观察行为而不伸进去的 public boundary；测试住在 seams 上。**只在预先商定的 seam 上测试**——写任何测试前列出打算用的 seams 与用户确认，每个候选注明"能 catch 什么、漏什么"（测试努力有限，落在关键路径而非每个 edge case）
- **循环规则**：**Red before green**（先写失败测试，再写"恰好够让它通过"的代码）；**One slice at a time**（一个 cycle = 一个 seam + 一个测试 + 一个最小实现，每个测试是 **tracer bullet**）
- **Refactoring 不在循环内**：2026 年 6 月移除了 refactor 步——agents 几乎从不做那一步，重构归 `code-review`（触发词里保留 "red-green-refactor" 是已知的不一致）
- **Mocking 规则**（mocking.md）：只在**系统边界** mock——外部 API、时间/随机性；**绝不 mock 自己的类/模块/内部 collaborator**；偏好 **SDK 式接口而非通用 fetcher**（每个外部操作一个具体函数，每个 mock 只返回一种 shape）

**为什么这样设计**：
- **为什么 vertical slice / tracer bullet**：第一个 cycle 端到端打穿一条路径，响应实况而非图纸；一次一个 slice 让每个测试响应上一轮所学
- **为什么 pre-agreed seams**：整链中 seam 甚至更早由 `to-spec` 商定、`code-review` 事后检查——三处闭环
- **为什么 codebase-design 是 prerequisite**：v1.0 把 tdd 原有的 deep-module 笔记抽出去 generalize 成共享 skill，tdd 只留指针——**tdd 拥有"seam 作为测试边界"的语义，codebase-design 拥有 seam 后面的模块形状**

**被谁调用**：implement（每张 ticket "at pre-agreed seams"）、implement-spec（每个 implementer subagent 内调）。

---

## domain-modeling — 主动磨利领域模型

**定位**：在设计中**主动构建和磨利**项目领域模型：挑战术语、发明 edge-case 场景压测、在术语/决策**结晶的当下**写进 `GLOSSARY.md` 和 ADR。

**解决什么**：① **统一语言腐化**（"cancellation" 两义、"account" 三个文件里干三件事）；② **决策失忆**（难逆的架构选择没有记录，六个月后有人再提 GraphQL、或"好心修掉"刻意为之的偏离）。

**与"被动读词汇表"的分界**（invocation.md 专门写了这条）：读 `GLOSSARY.md` 借词汇是任何 skill 都能做的一行习惯；只有**主动的** build/sharpen 纪律（挑战术语、压测场景、写 ADR、inline 更新）才是 domain-modeling。

**Session 内五个动作**：
1. **Challenge against the glossary**：用户用语与 GLOSSARY 冲突立即指出
2. **Sharpen fuzzy language**："'account' 是指 Customer 还是 User？这是两个东西"
3. **Discuss concrete scenarios**：发明 probe edge case 的具体场景，逼出概念边界
4. **Cross-reference with code**：用户说能部分取消，代码取消的是整个 Order——哪个对？
5. **Update GLOSSARY.md inline**：术语解决的**当场**写入（不攒批）——"session 结束才补写的 glossary 只是 session 的摘要，inline 版本才是 session 的产出"

**ADR 三重门槛**（三条**全真**才写）：① **Hard to reverse**（反悔成本大）；② **Surprising without context**（未来读者会问为什么）；③ **The result of a real trade-off**（存在真替代项）。ADR 正文 1–3 句即可——"价值在于记下做了决定和为什么，不在于填表"。

**为什么这样设计**：
- **GLOSSARY "只是 glossary"**：实践中最常破的规则——模型把"写 GLOSSARY"当许可，把你每个回答都持久化，文件长成 running spec（docs 记录了 500–3000 行的膨胀案例）；只收本项目特有术语，通用编程概念不收
- **有主见**（opinionated）：同义词并存时挑最好那个，其余列 `_Avoid_` 别名——"This is how language compresses"
- **懒创建**：第一个术语敲定时才建文件

**被谁调用**：grill-with-docs（开场 "Call the Skill tool **twice**, for 'grilling' and 'domain-modeling'"）、wayfinder（Grilling ticket 同样双调）、improve-codebase-architecture（决策结晶时调用）。

---

## codebase-design — 深模块的共享词汇表

**定位**：设计 **deep modules** 的共享词汇表（reference，不是 process）："consistency of language is the whole point"。

**解决什么**：设计对话里 "component / service / API / boundary" 各说各话——**没人一致使用的术语比没有术语更糟**；以及浅模块蔓延（大 interface + 薄实现，复杂度漏给 caller）。

**八个术语**（每个都带 Avoid 替代词）：

| 术语 | 定义 | Avoid |
|---|---|---|
| Module | 有 interface 和 implementation 的任何东西（刻意的 scale-agnostic） | unit, component, service |
| Interface | caller 正确使用该模块必须知道的**一切**（类型之外还有 invariants、ordering、error modes） | API, signature |
| Implementation | 模块内部代码体 | |
| Depth | **interface 处的 leverage**——caller 每学一单位 interface 能驱动多少行为 | |
| Seam | 不改此处代码就能改变行为的地方（Michael Feathers）；是 interface 的**位置** | boundary（与 DDD 撞词） |
| Adapter | 在 seam 处满足 interface 的具体物；描述**角色** | |
| Leverage | caller 从 depth 得到的 | |
| Locality | maintainer 从 depth 得到的（变更集中一处，fix once, fixed everywhere） | |

**四原则**：① Depth 是 interface 的属性不是 implementation 的；② **The deletion test**：想象删掉模块——复杂度消失 = 它只是 pass-through，复杂度在 N 个 caller 身上重现 = 它在挣饭吃；③ **Interface 即 test surface**（想测到 interface 之外 = 模块形状不对）；④ **One adapter means a hypothetical seam. Two adapters means a real one.**

**两个按需加载的延伸文件**：
- **DEEPENING.md**：如何安全深化浅模块——先把候选依赖分类（in-process / local-substitutable / remote-but-owned / true-external），**类别决定深化后怎么跨 seam 测试**；**replace, don't layer**（深化后旧浅模块的单测变废品，删掉）
- **DESIGN-IT-TWICE.md**（源自 Ousterhout "Design It Twice"：**你的第一个想法不太可能是最好的**）：**并行 spawn 3+ sub-agents**，每个产出一个激进不同的 interface（最小化 interface / 最大化灵活性 / 为最常见 caller 优化），然后按 depth / locality / seam placement 三维对比，**给出自己的推荐**——"用户要的是 strong read，不是菜单"

**为什么这样设计**：
- **拒绝 Ousterhout 原版的 depth 定义**（implementation 行数比 interface 行数）——那会奖励往 implementation 里灌水，改用 depth-as-leverage
- **为什么 reference 不做 driver**：无循环、无产物、无提问——所有碰设计的 skill 来这里取词。docs 记录的已知失败正是 agent 把它当 process 跑（issue #449，自己发明流程烧了几十万 token）
- **为什么 Design It Twice 并行多代理**：第一个设计想法锚定；并行激进约束强制探索真正的设计空间而非同一设计的微调

**被谁调用**：improve-codebase-architecture（HTML 报告的建筑名词和动词全部来自它）、tdd（interface 形状成问题时调它取词汇）。它与 domain-modeling 是平行的词汇层双子：**一个管模块形状，一个管领域词汇**。

---

## code-review — 双轴并行评审

**定位**：对 HEAD 与指定 fixed point 之间的 diff 做**双轴评审**——**Standards**（仓库文档化的编码标准 + Fowler smell 基线）与 **Spec**（是否忠实实现源头 issue/spec）——两轴各跑一个**并行 sub-agent**，报告并排呈现、**永不合并或重排**。

**解决什么**："一个改动可以通过一轴而挂掉另一轴"——每条标准都对却实现了错误的东西（Standards 过 Spec 挂）；精确做了 issue 要求的事却破坏项目约定（Spec 过 Standards 挂）。**混合裁定会让通过的一轴掩盖挂掉的一轴**。

**工作流程**（5 步）：
1. **Pin the fixed point**：取 `git diff <fixed-point>...HEAD`（**三点**，从 merge-base 度量）；先 `git rev-parse` 验证 ref 可解析、diff 非空——坏 ref 应该在这里失败，而不是在两个并行 sub-agent 里失败
2. **识别 spec 来源**：commit 里的 issue 引用 → 用户传的 path → spec 文件 → 问用户；没有就跳过 Spec 轴并报告 "no spec available"——**绝不从代码反推需求**
3. **识别 standards 来源**：搜仓库所有"代码该怎么写"的文件（CODING_STANDARDS.md、CONTRIBUTING.md）；其上**永远携带 smell baseline**：Fowler《Refactoring》ch.3 的 12 个 code smells（Mysterious Name、Duplicated Code、Feature Envy……每个配"是什么 → 怎么修"）。两条约束：**仓库优先**（文档化标准明确认可的，抑制对应 smell）；**永远是 judgement call**（标注式启发，不是硬违规）
4. **并行 spawn 两个 sub-agent**：Standards 轴拿着标准文件 + 全文粘贴的 smell baseline 逐 hunk 报告冲突；Spec 轴拿着 spec 逐要求核对
5. **并排呈现**两份报告

**为什么这样设计**：
- **为什么两个并行子代理**：两轴推理**互不污染 context**；"同一 context 评审自己不是评审，是带 slash command 的确认偏误"
- **为什么仓库文档优先**：通用评审 skill 不知道你的标准——会 flag 你刻意为之的东西、漏掉你依赖的 invariants
- **为什么 sub-agent 输出 400 词上限 + 强制引用**：可核验性——"sub-agent 输出是 hypothesis 不是 evidence"
- 已知问题（docs 坦承）：无收敛保证——"把它当线索清单处理，别跑到它干净为止（永远不会）"

**被谁调用**：implement（每张 ticket 完成后）、implement-spec（integration branch 上全量一次）。与 retro 成对：评审漏掉某类错误时，retro 提出 Standards 轴之后会读的规则。

---

## pr — PR body 的形状

**定位**：PR body 的**格式参考**（不是工作流）：三段模板——Summary（让变更清晰的最小**视图**）、Evidence（before/after 证明它工作）、Merge Danger（one-way/two-way door + blast radius）。

**解决什么**：用户对 agent PR body 的一贯抱怨："一大段总结，而我只想知道**改了什么、怎么验证的、会炸什么、能不能安全 merge**"。reviewer 手边已经开着 diff——body 该在做他们读 diff 之前给出**形状**。

**Summary 的六种视图**（按主题选**最小**视图）：逻辑/算法 → pseudocode；运行时控制流 → call tree；UI 结构 → component tree；文件职责 → 浅 file tree；组件交互 → Mermaid；"变了什么本身是重点" → **shaped diff**（组件变更用组件 diff、文件布局变更用树形 diff……）。"可能用一个、有时几个、几乎不会全用。"

**Evidence**：before 和 after 成对的具体证据。**Screenshots 是 S-tier**；"Tests are green" 单独出现是 claim，不是 before/after。

**Merge Danger**：**one-way door**（走得回不去：破坏性动作、难逆决定）vs **two-way door**（可低成本走回）；**blast radius** = 潜在影响面。它把"merge 安全吗"从直觉变成**可反驳的 stated claim**，并告诉 reviewer 人力该花哪——two-way 小半径扫一眼，one-way 慢读。

**为什么这样设计**：
- docs 的诚实警告：**写变更的 agent 自己在给自己打分**，"two-way, small blast radius" 时最该怀疑；diff 常藏住不可逆性（"回滚一个 commit 不会撤回已发出的批量邮件"）
- **来源致谢**（CREDITS.md）：视图菜单近乎逐字来自 Dex Horthy 的 `show-me` skill——因为对方不在本仓库、硬链接会破坏 standalone 安装，所以**复制内容而非指向**，CREDITS.md 就是依赖本该带的 attribution

**被谁调用**：无硬调用——**model-invoked 使 agent 每次写 PR body 时自动套用此形状**。链位：`code-review` 在它**之前**（body 描述的是已评审过的 diff）。

---

## wizard — 只有人能做的步骤，变成程序

**定位**：生成一个**交互式 bash 脚本**，逐步带人类走完只有人能做的手工流程（开 dashboard、点按钮、复制 key）：脚本自己开 URL、精确指示点哪里抄什么、捕获值写进 `.env` / GitHub secrets、显示剩余阶段——**agent 只写不跑**。

**解决什么**："对 AI 每次都要重新解释的、手工做又繁琐的流程"。docs 记载它的由来：以前 agent 构建中途撞上凭证墙，就把六步编号说明倒进聊天里任其滚走。Wizard 是**程序不是说明清单**——"当一步过时它会**显式失败**"，而不是静默失效。

**工作流程**（4 步）：
1. **Scope**：先读仓库（`.env.example`、`.github/workflows/*`——**每个 `secrets.*` 引用都是 wizard 必须产出的值**）再问用户；每个捕获值显式决定归宿：`.env` / GitHub secret / 两者 / 无处（纯动作型），以及是否 secret（隐藏输入）
2. **Map each stage's journey**："Dashboard → Developers → API keys → Reveal test key → copy"——**不知道当前 UI 就明说，绝不发明可能不存在的步骤**
3. **Author**：复制 `template.sh`，只写 stages 不动库；库函数 `stage`/`open_url`/`ask`/`ask_secret`/`write_env`/`set_secret`/`pause`/`confirm`；守住 bar：**问值之前先开它的 URL**、不可逆动作前 `confirm`、每个 stage 清屏只留当前步（"清屏后滚走的信息等于丢失"）
4. **Verify and hand off**：`bash -n` 语法检查 + **静态 trace**（每个值都被捕获且落到说好的地方）——**不端到端自己跑**（会开浏览器阻塞在人类输入上）；首跑就是用户的首跑，那也是测试

**为什么这样设计**：
- **为什么 agent 写但不跑**：跑的人是你、在你的机器上；这也保证了 **API key 不进模型 context**（脚本盲捕获直写，模型不接触值）
- **为什么固定库 + 只写 stages**：进度显示、隐藏输入、幂等 upsert（0600 权限、穿 symlink）、WSL 兼容、**重跑续传**（`.env` 现值作为默认——Enter 保留）这些 UX 已被解决；库的不变性 = 每个 wizard 行为一致
- **为什么 ephemeral by default**：一次性迁移用完即删；只有"仓库里下个人也要走的 setup 路径"才 commit 并从 README 链接——"让下一个人跑脚本而不是再问 AI"
- 演进（docs）：曾为 user-invoked 的 in-progress skill，**改为 model-invoked 正是为了修"agent 撞墙倒步骤进聊天"的失败**——agent 撞到只有你能过的墙的瞬间就会够到它

**被谁调用**：无硬调用；与 implement 成对（build 需要凭证/cutover 的 feature 时，wizard 覆盖只有人能做的步骤）。

---

## 本章关系速查

| Model-invoked | 被谁调用 |
|---|---|
| prototype | wayfinder、ask-matt（detour） |
| diagnosing-bugs | 无直接调用；ask-matt 路由 |
| research | wayfinder（research ticket） |
| tdd | implement、implement-spec |
| domain-modeling | grill-with-docs、wayfinder、improve-codebase-architecture |
| codebase-design | improve-codebase-architecture、tdd |
| code-review | implement、implement-spec |
| pr | 无人硬调用；写 PR 时自动套用 |
| wizard | 无人硬调用；撞墙时自动够到 |

## 上一章 / 下一章

- 上一章：[03-engineering-用户调用篇.md](./03-engineering-用户调用篇.md)
- 下一章：[05-productivity篇.md](./05-productivity篇.md)
