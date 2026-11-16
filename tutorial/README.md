# mattpocock/skills 中文教程

> 帮你读懂 [mattpocock/skills](../README.md) 仓库的全部 38 个 agent skills：**它们各自做什么，以及为什么这样设计。**
>
> 所有内容以仓库源文件（SKILL.md、docs/、.agents/、README）为唯一事实来源。

## 这个仓库是什么（30 秒版）

Matt Pocock（Total TypeScript / AI Hero 作者）日常真实使用的 agent skills 集合——"Skills For Real Engineers"。针对 agent 编码的四大失败模式（**没做我想要的 / 太啰嗦 / 代码跑不起来 / 大泥球**）各给出一组小而可组合的解药。反对 GSD / BMAD / Spec-Kit 式的"流程全家桶"：小、易改、可组合。

## 教程目录

| 章节 | 内容 |
|---|---|
| [01 全景图](./01-全景图.md) | 仓库定位、四大失败模式、目录组织（buckets）、主线工作流预览 |
| [02 设计原则](./02-设计原则.md) | 六大系统级决策：user/model-invoked 二分、Skill tool 组合、强策展、自我管理、上下文卫生、人是所有者 |
| [03 Engineering 篇（上）](./03-engineering-用户调用篇.md) | 11 个用户调用 skill：ask-matt、grill-with-docs、triage、improve-codebase-architecture、setup、to-spec、to-tickets、implement、implement-spec、wayfinder、retro |
| [04 Engineering 篇（下）](./04-engineering-模型调用篇.md) | 9 个模型调用 skill：prototype、diagnosing-bugs、research、tdd、domain-modeling、codebase-design、code-review、pr、wizard |
| [05 Productivity 篇](./05-productivity篇.md) | 7 个通用工具：grilling（★原语）、grill-me、handoff、teach、to-questionnaire、wait-what、writing-for-agents |
| [06 Misc 与 In-Progress 篇](./06-misc与in-progress篇.md) | 11 个非主推 skill + 两个桶的生命周期设计 |
| [07 工作流组合](./07-工作流组合.md) | 完整链路图、阶段边界决策树、调用关系图、一次完整旅程走查 |

## 速查与课程

- [skills 速查表](./reference/skills-cheatsheet.html)：全部 38 个 skill 的一页式参考（可打印）
- [第一课：识别调用类型与失败模式](./lessons/0001-skill-invocation-and-failure-modes.html)：带测验的互动课程
- [第二课：主线工作流走查](./lessons/0002-main-flow-walkthrough.html)：idea → ship 五步 + 场景演练 + 测验
- [第三课：grilling 实操演练](./lessons/0003-grilling-practice.html)：互动模拟——亲历两轮拷问、frontier 推进与 ADR 落地
- [第四课：深模块词汇专题](./lessons/0004-deep-module-vocabulary.html)：codebase-design 八词汇 + deletion test 三连练 + 测验
- [第五课：tdd 三大反模式实操](./lessons/0005-tdd-anti-patterns.html)：挑错五连练 + seam 三段闭环 + 测验
- [第六课：code-review 双轴拆解](./lessons/0006-code-review-two-axes.html)：两轴隔离的原理 + Fowler smell 识别三连练 + 开课检索热身
- [第七课：wayfinder 决策地图](./lessons/0007-wayfinder-map.html)：map 五节解剖 + 四种票型 + fog/ticket 判据五连练（进哪一格）
- [第八课：retro 复盘环境](./lessons/0008-retro-environment.html)：七类别落点表 + "这个挣扎变成什么"五连练 + 0006 补讲内嵌测验

## 一张图记住整个仓库

```
四大失败模式            →  解药
─────────────────────────────────────────────
① 没做我想要的（对齐）   →  grilling 家族（grill-me / grill-with-docs）
② 太啰嗦（语言不共享）   →  domain-modeling（GLOSSARY.md + ADR）
③ 代码跑不起来（反馈）   →  tdd / diagnosing-bugs
④ 大泥球（设计腐化）     →  codebase-design / improve-codebase-architecture
                          to-spec / to-tickets（把设计意识前置）

主线：grill-with-docs → to-spec → to-tickets → implement（内驱 tdd）
      → code-review → pr → retro
匝道：triage（外来需求）/ diagnosing-bugs（坏了）/ wayfinder（迷雾）

不变式：user-invoked 编排（人驱动），model-invoked 承载纪律（agent 复用）；
        前者可调后者，绝不调另一个前者。
```

## 教学工作区说明

本文件夹是按仓库自带的 [`teach`](../skills/productivity/teach/SKILL.md) skill 规范搭建的教学工作区：

- `MISSION.md` 学习使命（所有教学决策的锚点）
- `RESOURCES.md` 高信任资源清单
- `NOTES.md` 教学偏好与工作记录
- `lessons/` 互动课程（HTML）
- `reference/` 压缩速查参考（HTML，打印友好）
- `assets/` 课程共享组件（样式表等）

**有任何看不懂的地方，直接问你的 agent**——它是你的老师，可以就任何一个 skill 展开讲、演示、或带你实操。

## 推荐的首要资料

[README.md 的 "Why These Skills Exist" 章节](../README.md)——作者本人写的四大失败模式，是理解整个仓库的钥匙。
