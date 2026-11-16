# 05 Productivity 篇：7 个通用工作流 skill

> 本文来源：`skills/productivity/` 下 7 个 SKILL.md、teach 的 4 个 *-FORMAT.md、writing-for-agents 的 SKILL-MECHANICS.md

这一桶与代码无关，是通用思维工具。但它藏着整个仓库**最重要的一个 skill**：grilling（拷问原语）。

---

## grilling — 被复用的访谈原语 ★

**定位**：整个 grilling 家族的可复用"无情访谈"原语：把主题建模为 **design tree**，以 **rounds** 为单位、每轮问完整个 **frontier**，直到没有任何未言明的假设。

**解决四个失败模式**：
1. **隐性假设**：方案里塞满没人说出口的假设
2. **一次一个问题太慢**：13 个问题逐个问要 13 次往返，grilling "typically land in about three rounds"
3. **一次全问会问出坏问题**：会问出依赖尚未听到答案的问题
4. **agent 自问自答**（docs："An agent running `grilling` that answers its own decisions has broken the skill"）和把可自查的事实拿去烦用户

**工作纪律**：
1. **建模**：把主题映射为 design tree——"every decision branches into the decisions that hang off it"（每个决策分叉出挂在它下面的决策）
2. **计算 frontier**：frontier = 前置决策已全部敲定的那些问题——"现在就能问、不用猜还没听到的答案"
3. **一轮问完整个 frontier**，固定格式：
   ```
   ❓ Q1 - <问题标题>: <问题正文，可多段/含选项>
   ➡️ <agent 的推荐答案>
   ---
   ❓ Q2 ...
   ```
   措辞规则："Word each question so 'yes' accepts your recommended answer"——把开放式盘问变成**快速审批 + 纠偏**
4. **等答案，重算 frontier**：settled 的决策把 frontier 向外推，解锁被阻塞的问题
5. **facts vs decisions 分工**："Finding *facts* is your job, never the user's."——需要环境事实就派 sub-agent 去查，**绝不问用户任何你能自己查到的东西**，且不阻塞（正在跑的探索算一个 unsettled prerequisite，frontier 其余部分照常问）。"The *decisions* are the user's: put each to them and wait."
6. **结束 + 确认门**：frontier 为空即没有沉默假设；但 "Do not act on it until the user confirms"——防止较弱模型问两三个问题就跑去写 outline

**为什么这样设计**：
- **为什么 rounds 而非一次一问**：往返次数从问题数压到轮数；frontier 保证**同一轮内问题互不依赖**，合并提问不会作废同轮任何问题。历史上 round-based 提问曾短暂作为独立 skill `batch-grill-me` 发布，后来**合并进 grilling**，让所有建在原语上的 skill 一次性获得该能力——单一 source of truth
- **为什么没有 async 模式**："a grilling session that nobody answers has produced the agent's opinion rather than yours"
- **已知局限**（docs 诚实列出）：frontier 由 agent 判断而非从图计算，可能两问同轮、之后才发现一个答案本应改变另一个——唯一护栏是"下一轮重开受影响分支"

**被谁调用**：grill-me、grill-with-docs、wayfinder、triage、improve-codebase-architecture——一份纪律，五个入口。docs 定位："primitive, not a step you schedule"。

---

## grill-me — 无状态拷问入口

**定位**：**只有一行正文的 skill**："Call the Skill tool with 'grilling'."——grilling 的 stateless 用户入口。

**与 grill-with-docs 的分工**：grill-me **不写任何文件、不假设主题与软件有关**（人们用它做商业决策、写作、决定下一步做什么）；有工作目录时 grill-with-docs 是 strictly better（同一访谈 + 留痕）。

**使用建议**（docs）：在**全新对话**中键入；关掉 plan mode，否则 agent 会急着产出计划而不肯继续提问。

**docs 警告的失败模式**：
- **Passivity**：对四十个问题一路 "agreed"，产出一个 agent 写的、你只是点头过的方案——"feels productive because it was long. But you decided nothing"。判断标准："You disagree with something. A session with no pushback from you is a session you didn't need."
- **Ungrillable 问题**（"one long form or three pages?"）——靠谈话无法回答，硬谈会越拖越长，应转 `prototype`

**为什么只有一行**：状态入口与机制分离——grill-me 不重复任何访谈逻辑，机制升级（如 round-based）一次到位。

---

## handoff — 可移植的交接文档

**定位**：把当前对话压缩成一份 handoff document，供一个全新 agent 接手。docs 开宗明义："What it gives you is **portability**, not compression, so the skill is narrower than it sounds."

**四个且仅四个触发场景**：换 harness（Claude → Codex）；换目录/repo（prototype 目录最常见）；交给同事；**fork 一个 mid-phase 发现的侧任务**（"the use people skip"）。其余场合用 `/compact`。

**工作流程**：写总结到 **OS 临时目录**（`$TMPDIR` / `/tmp` / `%TEMP%`——"a handoff is a document in transit, not an artifact you maintain"，明确不写进工作区）→ 文档包含 **"suggested skills" 小节**（点名下一个 agent 应调哪些 skill）→ **不复制**已被 specs/issues/commits 捕获的内容，只以 path/URL 引用（"instead of two copies that drift apart"）→ **Redact 敏感信息**（文件会去到你不控制的环境）。

**为什么这样设计**：
- **与 /compact、/clear 的三分**：`/compact` 保 intent（继续同一任务），`/clear` 什么都不保，`/handoff` 保"工作可移动性"——三者都把 primary source 变成 secondary source，所以要先排除"继续"
- **与 CLAUDE.md 的分界**："Ask whether it's true next month." 长期事实进 CLAUDE.md，半成品任务进 handoff
- 已知批评："captures the what, not the why"——缓解办法是传参数说明下一 session 用途

---

## teach — 有状态的教学系统 ★

**定位**：把**运行它的当前目录变成一个有状态的教学 workspace**，跨多个 session、以短小自包含的 HTML 课程为载体，长期教授一个主题——"when the learning is the project"。

> 你现在读的这个 `tutorial/` 文件夹就是按 teach 的规范搭建的。

**针对 LLM 教学的四个失败模式**：
1. **Parametric knowledge 不可信**："Never trust your parametric knowledge."（docs 记录的真实事故：学 2x2 魔方的用户收到了根本解不开的编造公式）
2. **Fluency 假象**：读课时觉得都会、一周后全忘
3. **学习状态无法跨 session 累积**：状态放目录文件里，"the next session continues from those files, not from what is left of the last conversation"
4. **教学与目标脱节**：没有 mission 的课程会 "feel too abstract"

**工作区文件结构**：

| 路径 | 作用 |
|---|---|
| `MISSION.md` | 学习的**理由**。规则：One mission per workspace；Concrete over abstract（"Run a half marathon by October" beats "get fitter"）；"If MISSION.md runs past a screen, it has stopped being a compass and started being a plan" |
| `RESOURCES.md` | 高信任资源清单，分 Knowledge / Wisdom (Communities) 两组；"A bare link is useless in three months"；"Better five sharp sources than thirty mediocre ones" |
| `lessons/*.html` | **教学的主单元**：一课一个自包含 HTML，短（working memory 很小）、给一个 tangible win、美（"Think Tufte"，用户会回来复习）、带 citations、推荐一个 primary source |
| `reference/*.html` | 课程的**压缩精华**：cheat sheets、glossaries——"Lessons will rarely be revisited later - reference documents will be" |
| `learning-records/*.md` | **教学界的 ADR**：只记 decision-grade 的理解变化（不是活动日志——"Learning records are not a journal"），用于计算 ZPD；后来的记录推翻早前的标记 superseded 而非删除 |
| `assets/*` | 跨课程复用组件（stylesheet、quiz widgets）；"Reuse is the default" |
| `NOTES.md` | agent 的草稿本：用户偏好 |

**教学理论：Fluency vs Storage Strength**：
- **Fluency strength**（当场提取）给人 illusory mastery；**Storage strength**（长期留存）才是真目标
- 建设留存的手段：retrieval practice（回忆练习）、spacing（间隔）、interleaving（交错，仅限 skills）
- **核心辩证法——难度在不同阶段扮演相反角色**：
  - Knowledge 获取："difficulty is the enemy. It eats working memory you need for understanding."
  - Skills 训练："difficulty is the tool. Effortful retrieval is what builds storage strength."
- **ZPD**（Zone of Proximal Development）：每课让用户 "challenged 'just enough'"，靠 learning-records + mission 计算
- **Wisdom**："comes from interacting with other learners and practitioners"——agent 默认尝试回答，但最终 delegate 给 community

**Quiz 反作弊规则**（很能体现设计精度）：每个选项**字数完全相同**、正确答案位置跨题轮换、不得通过格式泄露线索。docs 披露已知 bug：正确答案仍总落在选项 A（33/33），指令级修复无效——**真正的修复是 assets/ 里一个能洗牌的 quiz 组件**（组件化设计的自证）。

**已知局限**（docs 诚实列出）：没有 assessment step（第一课没有 learning records 可读，会假设起点）；没有 spaced repetition 调度；没有退出条件（"good at making the next lesson, but not as good at knowing when to stop"）。

---

## to-questionnaire — 答案在别人脑袋里

**定位**：把你**独自无法解决的决定**变成一份 Markdown 问卷——交给唯一持有你所缺知识的那个人异步填写。

**核心纪律**："**Grill the send, not the subject**"——只访谈用户关于"发送"（他永远答得上来），绝不访谈主题本身（"not knowing the topic is why you're writing to someone else"）。访谈只有两问：① Who is it going to?（决定 tone 和 context 量）② What do you need back?（成为成品的 checklist）——然后写文件。

**为什么这样设计**：
- **最重要优先 + 一问一想法**："async means you may only get one pass"
- **显式允许 "I don't know"**："a flagged uncertainty is useful and a confident guess that reads like a fact is not"
- **为什么单收件人**：整份文档的 tone 对准一个人；三个人持有三部分答案就跑三次
- **为什么不是 branching 文档**（曾探索但没 ship）："A model that plans more than two or three questions ahead of a real answer plans badly, and a branching document has to plan all of them ahead of every answer."
- **与 grill-me 的本质区别**：不在交付方式，而在**答案在谁的脑袋里**——grilling 从你这里取，questionnaire 从别人那里取

**典型场景**：grilling session 停在"不归你答的问题"上——同一对话里运行 `/to-questionnaire` 把问题 offline。

---

## wait-what — 三行的修复指令

**定位**：当你没看懂 agent 的上一条消息时，让它 "re-pitch that"——补上你缺的 context，用 **ASD-STE100 Simplified Technical English** 和 `GLOSSARY.md` 的词汇重讲一遍。正文只有一句话。

**解决什么**：流行的修法（`/tldr`、"be concise"）失败于同一处——它们命名的是**输出**，模型于是"clips words and loses you further"，产出**更短但同样难懂**的碎片。

**为什么这样设计**（这是全仓库最精妙的设计案例之一）：
- **"The name is the mechanism"**：leading word 是 **wait**。"Be concise" 是关于输出的指令；**wait 是关于听者状态的指令**——"It says you stopped understanding here." 听到 "wait, you lost me" 的 agent 会退回去解释
- **为什么只有三行**："That is the design, not an unfinished draft." 对抗 verbosity 的 skill 通常失败于自己变长——"the model copies the length of the skill, not its request"。一个 400 行的"简洁"skill 仍然留下一个 verbose 的模型
- **user-invoked 的理由**："Only you know when you stopped following."
- 事前修复是 grill-with-docs（提前建立共享语言）；它是**事后**修复单条消息

---

## writing-for-agents — 写 agent 文档的元规范 ★

**定位**：写**一切 agent 消费的文档**（skill、AGENTS.md/CLAUDE.md、spec、任何经 pointer 到达的 doc）的统一规范。核心主张："**The packaging differs; the writing does not**"。v1.1 前叫 `writing-great-skills`，改名因为 "Almost none of it is specific to skills"。docs："**Every skill here was written with it**."

**对抗的失败模式家族**：no-ops（"it spends most of its words explaining what the model already knows"）、duplication（一个意思多处重复）、sprawl（文档太长，"every extra line is one more to keep relevant"）、sediment（加感觉安全删感觉危险，陈旧层沉积）、scattering（一个意思碎成多片）。

**相互咬合的杠杆**：

**① Context pointers**：pointer = 保存在 agent context 里、指向 context 外材料的引用。关键论断："**The pointer's _wording_, not its target, decides when the agent reaches the material, and how reliably.**" 必备材料藏在弱措辞 pointer 后面 = variance bug——先磨措辞，磨不动才 inline。

**② The two loads**：每份文档花两种预算之一——**Context load**（always-loaded 材料对 agent 窗口的成本，每 turn 付费）vs **Cognitive load**（对**人类**的成本：记住哪些文档存在）。"The human is the index."——这**不是要最小化的成本，而是人类 agency 的代价**：在人类判断重要处花，不重要处移除。

**③ Information hierarchy**：每块内容在三级阶梯上的位置——in-file step（agent 按序执行）→ in-file reference（按需查阅）→ disclosed reference（推到单独文件、经 pointer、触发才加载）。**Progressive disclosure** "Not primarily a token optimisation: it is how the hierarchy is protected"；**branching 是最干净的 disclosure 测试**：每个 branch 都需要的 inline，只有部分 branch 到达的推到 pointer 后。

**④ Completion criteria**：每步以可区分 done/not-done 的判据结束。模糊边界招来 **premature completion**——防御有顺序：先 sharpen the bound（便宜），只有不可约地模糊且确实观察到赶工，才靠 context boundary（hand-off 或 subagent dispatch）隐藏后续步。

**⑤ Leading words**：**预训练里已有的紧凑概念**（_fog of war_、_tracer bullets_、_tight_、_red_）——招募模型已有的 prior，用最少 token 锚定一整片行为；自造词要"pay in definition tokens what a pretrained word gives free"。旁边的失败模式是 **Negation**：禁止句把被禁行为拖进 context 使其**更**可得（_don't think of an elephant_）——**正面 prompt 目标行为**。

**⑥ Pruning**：Single source of truth（leading word 故意重复 **token**、从不重复 **meaning**）；**Environment 也是 source of truth**（package.json scripts、config）——重述它的文档是 cache，只 cache agent 查不到的东西；**No-ops 逐句猎杀**，测试是"相对默认是否改变行为"——"two people disagreeing about a no-op disagree about the default, and settle it by **running the document**, not by debate"。**默认修复是删除而非解释。**

**SKILL-MECHANICS.md**（skill 特有分支，本身是 progressive disclosure 的示范）：model-invoked 的 description 是顶层 context pointer——"model-invocation always *includes* user reach; a description only ever adds agent discovery, never removes the human's"；user-invoked 零 context load、付 cognitive load（"you are the index that must remember it exists"）。**只在 agent 必须自主到达、或另一个 skill 必须到达时才选 model-invocation。**

**被谁调用**：retro（提出任何 steering file 或 skill 之前先加载它）——它是所有其他 skill 产出的、要被 agent 读的文档的元规范。

---

## 七个 skill 的关系速览

- **grilling** 是被复用的原语；**grill-me** 是它的 stateless 入口
- **to-questionnaire** 是 grilling 的"答案在别人脑袋里"外延；**prototype**（上章）承接 ungrillable 问题
- **handoff** 是跨 session 移植器，与 prototype（往返）和 teach（学完回来继续 grill）配对
- **teach** 是独立的有状态教学 workspace
- **wait-what** 事后修复单条消息，事前修复是 grill-with-docs
- **writing-for-agents** 是所有文档的元规范（retro 是唯一直接调用者）

## 上一章 / 下一章

- 上一章：[04-engineering-模型调用篇.md](./04-engineering-模型调用篇.md)
- 下一章：[06-misc与in-progress篇.md](./06-misc与in-progress篇.md)
