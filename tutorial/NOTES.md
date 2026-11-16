# 备注

## 用户偏好
- 语言：中文（保留英文术语不翻译）
- 需求：教程文档放在根目录单独子文件夹（`tutorial/`），要覆盖"每个 skill 是做什么的"+"为什么要这样设计"两个维度
- 用户通过 `/teach` 发起，说明希望以教学工作区的方式组织（本文件夹即工作区）

## 工作记录
- 2026-10-18：初始化工作区；派出 4 个子代理分组精读 38 个 skill 源文件
  （engineering 用户调用类 / engineering 模型调用类 / productivity / misc+in-progress）
- 2026-10-18：教程交付完成——7 个 Markdown 章节 + README 目录 + HTML 速查表（reference/）
  + 第一节带测验的 HTML 课程（lessons/0001，主题：调用类型与失败模式）
- 2026-10-18：lesson 0002（主线工作流走查）按用户请求交付；
  含五步主线、两个岔路口、上下文卫生、场景演练（分享功能走查）与四题测验
- 2026-10-18：lesson 0003（grilling 实操演练）按用户请求交付；
  纯前端互动模拟：博客评论系统场景，2 轮 4 问 + 分支 frontier + 事实题演示（子代理代答）+
  结算屏（GLOSSARY 术语 / ADR 三道门检验）+ 四题测验（正确位轮换 3,1,4,2）。
  同时把测验组件抽为 assets/quiz.js（修复 0001/0002 的内联重复——落实"reuse is the default"）
- 2026-10-19：lesson 0005（tdd 三大反模式实操）交付；挑错五连练（同义反复/旁路验证/
  mock 内部/横切计划/GOOD 范本）+ seam 三段闭环 + 四题测验（位置 1,3,2,4）。
  至此四大失败模式各有对应课程：#1 grilling（0003）、#3 tdd（0005）、#4 深模块（0004）
- 2026-10-19：lesson 0006（code-review 双轴拆解）交付。按 NOTES 计划，开课加了两道
  检索热身题（考上一课反模式——spaced retrieval，也算延迟的理解检验）；
  正文：两轴各查什么、隔离原理（确认偏误）、12 smells 速览 + 三连练（数据泥团/重复开关/消息链）、
  retro 配对；四题测验（位置 2,4,1,3）
- 2026-10-19：用户回报 0006 两道热身题**全对**（worked example / 实现耦合）→ 写了第一条
  learning record（`learning-records/0001`，tdd 反模式判据可延迟检索）
- 2026-10-19：lesson 0007（wayfinder 决策地图）交付。结构：map 五节可视化（mapviz 组件内联于本课）
  + 四种票型表 + fog vs ticket 判据（"sharp 的是问题，不是答案"）+ plan-don't-do 与 Notes 自我豁免
  失败案例 + "进哪一格"五连练（ticket/雾/票型/out-of-scope 混合出题）+ 四题测验（位置 3,1,4,2）
- 2026-11-10：用户点名讲 retro——先在对话里完整讲了一遍（定位/四步/七类别/两思想/弱点），
  用户随后确认 0008 做 retro 专题
- 2026-11-10：lesson 0008（retro 复盘环境）交付。开课热身考 0007（session 分界线 + fog/ticket）；
  正文七类别落点表 + mechanical/judgement 分类 + reviewer 执法论证；五连练"这个挣扎变成什么"
  （banned API→check / 18 次 tool call→pointer / 风格分裂→standards / 看不见日志→扩访问 / 模糊告诫→删 no-op）；
  四题测验（位置 4,2,3,1），其中 Q3 刻意内嵌 0006 隔离原理补讲
- 2026-11-10：用户回报 **0007 开课热身有错**（考的是 0006：两轴隔离原理 / no-spec-available）
  → 未写第二条 learning record；已在对话里补讲两个概念，并在 0008 测验 Q3 做二次曝光
- 下次会话候选主题：写 skill 实战（writing-for-agents 规范，retro 第一步就调它，顺位最自然）、
  阶段边界决策树（PHASE-BOUNDARIES）、diagnosing-bugs（匝道三件套最后一块未开课）、
  handoff 专题（用户已在问它和 retro 的接缝）、全链组合复习课
- 观察点：0009 开课热身考 0008（七类别落点 + mechanical/judgement 分界），
  **建议额外插一题重考 0006 隔离原理**（用户错过一次，间隔重检）；
  若 0008+0007 重考都全对，第二条 learning record 可写成"跨课延迟检索通过"；
  下课后测验位轮换回到 1,3,2,4
- 观察点（2026-11-10 追加）：用户开始提**组合层**问题——"handoff 时有环境陷阱是不是该 retro？"
  （正确连接了两个 skill 的边界，已在对话中补上分流判据："下个月还成立吗" + 先 retro 再 handoff 再 clear）。
  理解在向 skill 组合/接缝推进；等用户下一次**主动正确应用**这个分流（比如自己说出"这是系统性的，retro 它"），
  可写第二条 learning record（组合应用证据，比单纯检索更高级）
