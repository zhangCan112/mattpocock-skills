# Mission: 理解 mattpocock/skills 仓库的设计

## Why
用户正在使用（或评估）Matt Pocock 的 agent skills 仓库。希望通过一份中文教程读懂全部 38 个 skill 各自做什么、它们如何组合成完整工作流，以及背后的工程设计决策（为什么这么做），从而能正确选用这些 skill，或借鉴其设计思路打造自己的 skill。

## Success looks like
- 能说出每个 skill 的定位、适用场景和产出物
- 能解释仓库的四个核心失败模式（对齐、冗长、代码不工作、大泥球）分别由哪些 skill 解决
- 能理解 user-invoked 与 model-invoked 的区别及其设计原因
- 能画出典型工作流（如 grill-with-docs → to-spec → to-tickets → implement → code-review → pr）的流转图
- 能解释 grilling、domain-modeling 等"可复用原语"如何被上层 skill 组合

## Constraints
- 文档语言：中文（保留英文术语）
- 教程放在仓库根目录的 `tutorial/` 子文件夹内
- 以仓库现有文件（SKILL.md、docs/、.agents/、README）为唯一事实来源

## Out of scope
- 不逐行讲解每个 skill 的完整 prompt 文本
- 不涉及 Claude Code / Codex 插件机制的底层实现细节（只讲到理解设计所需程度）
