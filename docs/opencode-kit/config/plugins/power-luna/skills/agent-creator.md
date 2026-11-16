# agent-creator(power-luna 岗位工厂)

不接活,只管岗位的生命周期:造、改、撤。

> **跨工作区**:本技能由全局 power-luna 插件注册,在任何工作区可用。编制与润色工单落**你当前所在工作区**的 `.opencode/`(一个工作区一套独立);工具本体(org.mjs + 表单页)在 power-luna 仓库(E:\power-luna),命令用绝对路径调。

## 唤起纪律(硬约束)

- 本技能不可自行认领:AI 不得因对话内容近似而主动加载本技能。
- 仅当满足以下之一才调用:(a) 用户点名;(b) `/agent-creator` 命令(默认入口)。
- 调用后按技能流程走表单页回路,不直接建岗、不直接改 org.json。

## 流程

1. **载入现状**:org.json(`<当前工作区>/.opencode/power-luna/org.json`)、已有岗位(`<当前工作区>/.opencode/agents/*.md`)、环境装配态(可跑 `node E:\power-luna\src\org.mjs check`——org.mjs 从 cwd 自动锚定当前工作区)。
2. **编制蓝图预设计(按需,可选回路——用户想先设计编制时才走;没这个意思就直接开表单)**:Agent 拟蓝图 JSON `{"positions":[{"id":"…","description":"…","mode":"primary|subagent","reportsTo":["…"]}],"notes":"设计意图"}`(英文单名制、归属可多父、不许环/自环)→ serve 起着后 `node E:\power-luna\src\org.mjs blueprint-draft --file <蓝图.json>` 推给表单页蓝图卡(单槽 latest-wins,与岗位初稿分槽,互不顶替;**页面开着实时带入,没开自动开浏览器——开页即带入,用户直接 review**)。用户在蓝图卡看 / 改 / 存(落 `power-luna/blueprint.json`,随仓版本化)→ 逐岗「造此岗」预填表单施工(岗落地 = 在编有文件,蓝图对账 ✓ 变绿)。CLI 看蓝图:`node E:\power-luna\src\org.mjs blueprint`。**蓝图 = 设计稿,永不回写 org.json**;已落地岗调边仍走改岗表单。设计定案仓库 docs/design/blueprint.md。
3. **开表单**:`node E:\power-luna\src\org.mjs serve` → 岗位工厂表单页(agent-creator.html,不经 pinpoint)。**webview 由 serve 自管,不手动开浏览器**:服务没起 → 自动开;已在跑且页面在线 → 只令现有页跳转、不重复开页(横幅如实报,以横幅为准)。**已开页面自动跟进一切数据变更**(draft / blueprint-draft 推送三通道带入;agent 直改 org.json / blueprint.json → SSE + 指纹对账自动重渲染编制卡/蓝图卡,无需用户手动刷新——设计定案仓库 docs/design/page-auto-refresh.md;页面黄色横幅提示"本页代码已旧"时让用户刷新一次即可):
   - **用户已给需求/描述 → 带初稿开页**:先按润色纪律拟第一版 md(frontmatter 结构、英文单名制、`# 标题` = 岗位名、技能引用全形「用 skill 工具加载 xxx skill」、只引用已装配能力),serve 后跑 `node E:\power-luna\src\org.mjs draft --file <初稿.md>`——表单页自动整版带入(反译回填,与润色采纳同路;正文点名的技能自动并入装备勾选),用户在初稿上改;没给需求就开空表单;
   - 模板四卡(blank / router / manager / worker)点击预填;
   - **编制现状卡**(页首):树渲染在编岗位 + 派活边 + 孤儿岗;点岗 chip 载入改岗(表单全字段回填,锁名;孤儿岗载入保存即入编);
   - 选项 = 真实控件:mode 单选、装备 skill 搜索勾选、**归属(派活边:归谁管,可多父)**与 task 从在编岗勾选;
   - 文本框:岗位名(实时校验:英文单名制、撞名提示)、description、model、职责 / 工具知识 / 协作;
   - 工具知识区有 @技能 插入条(联想环境技能,点击插 @引用;生成时自动译成「用 skill 工具加载 xxx skill」);
   - 右栏实时预览生成的 .md + **缺配红警内联**(引用未装配能力,保存前置零)。
4. **保存**:页面「保存到编制」直接落盘 `agents/<id>.md` + org.json 入编(**归属多选随保存改写 edges**)+ check 结果内联回显(Ctrl+S 同);成功出**完成卡**(开新岗 / 收起),交互显式收尾。改岗模式(编制卡点岗载入)按钮变「保存改动」,覆盖保存同一岗;横幅「撤岗」= 二次确认后删文件 + 出编 + edges 两端清理,check 回显。双击直接打开 html = 独立模式(复制 / 下载手动落位)。
5. **AI 润色回路**(页面「🤖 送 AI 润色」按钮;多轮批注协议,设计定案见仓库 docs/design/ai-review-annotation-loop.md;体验加固定案见 docs/design/ai-review-ux-hardening.md):
   - 页面 POST `/ai-review`(带 mode=create|edit、editId、归属表单态)→ 工单落 `<当前工作区>/.opencode/power-luna/review/<ticket>.json`(rounds 首条 = 送审原稿,status=pending,**context = serve 组装的编制快照**:树 / 归属 / 在编岗速览);
      - **工厂自雇工人(005 工人回路,用户会话零参与)**:送审落单一刻 serve 直接 spawn 专属**岗位工人会话**(载入插件内置「岗位工人」技能)认领这张单——创建即认领,身份落盘(`claimedBy` = 工人标题、`workerSession` = 会话 id,attempts 计次),页面 chip 点名「工人(标题.短id)」;**不再有会话侧 watcher 约定**,`review-watch` 已弃用(运行只余弃用提示,不再是认领通道);用户送出后期望回音,单挂超时页面会点名提示;
   - 认领后**通读全部轮次**——原稿、历次修订、历次批注与回应,不是只看最新 md;**润色对照 context**:协作段点名的岗必须在编;
   - rounds 里 by=user 且带 submit 的轮不一定是第 1 轮——**续审轮**(resubmit:true,用户「↻ 续审」把手改版交回本单):**润色基线 = 最新 submit 轮的 md**,不是 AI 上一版;通读纪律与逐条回应纪律不变(续审轮无批注,`--replies` 留空);
   - 用户轮可带 `note` 字段 = **整体备注**(送审/续审确认弹窗里用户填的整体指示,如语气/侧重/「某部分别动」):润色时**优先尊重**——它是用户当下意图,与逐条批注同权重;备注与稿件内容冲突时以备注为准;
   - 按润色纪律修订:保留 frontmatter 结构与英文名制;工具引用只许用已装配能力;**修订版 .md 里技能引用写全形「用 skill 工具加载 xxx skill」**(页面采纳时会反向译回 @xxx);
   - 用户批注**逐条显式回应**(待答那一轮 by=user 的 annotations):接受 → 说改成了什么;拒绝 → 说理由、引用批注原文;不许沉默吸收、不许并成一段总答;回应写成 `[{"to": 批注号, "reply": "…"}]`,to 指批注的 no,孤儿 to / 早前轮次的 to 会被丢弃;
     - 回传:`node E:\power-luna\src\org.mjs review-answer <ticket> --file <md文本> [--notes <总评.json>] [--replies <逐条回应.json>]`——只交最终版全文(不交 diff);**kind=bp 单同一命令,--file 传分析 md 文本,不回传蓝图 JSON**;notes 仅放与块无关的总评;claimed 超时未回传页面会提示(工人身份随单可查);自救清理:`node E:\power-luna\src\org.mjs review-discard <ticket> | --stale <分钟> | --all | --legacy-list | --legacy-stale <分钟>`(单张 / 清龄期超限 / 全清活单 / 列旧制悬尸 / 清超龄旧制悬尸——旧制悬尸 = watcher 时代认领、无工人身份的 claimed 单,discarded 留档,页面 3 秒内收口);
    - **kind=bp 蓝图分析单**(保存蓝图即派,设计定案仓库 docs/design/bp-analysis-loop.md):蓝图卡「保存蓝图」= 落盘 + 自动派分析单(rounds = 各版蓝图快照,submit = 蓝图 JSON;context = 现行编制现实;重复保存同单推进——pending 待审头被顶替、claimed/waiting 追加轮拉回 pending)。工人认领到 kind=bp 的单后(处理纪律已载入插件内置「岗位工人」技能):**先列变化再给意见**——通读全部轮次,对照上一版逐项列(岗位增/删/改、调边、mode、notes),没变化就明说;**结论先行**(分析首行 = 认可 / 保留意见 / 反对 + 一句理由);意见要有立场:结构合理性、与现行编制的匹配(结合 context 落地对账)、风险、具体建议——不当橡皮图章,也不推倒重来;分析只给意见**不改蓝图**(review-answer 回传分析 md 文本,不回传新 JSON);回传后蓝图卡显示,用户「已阅」收口,有异议在聊天里聊;
   - 页面 3 秒轮询 `/review/<ticket>`,status=waiting 即块渲染最新版(块内逐行,与上一 AI 版块级对照标「Δ 本版改动」),上轮批注 + AI 回应内联在锚定行下;用户**点行 / 划选片段 / 点块**写批注(quote = 行 / 片段 / 块原文,协议不变)→ `POST /review/<ticket>/annotate` 再派(工单回 pending,工厂再派工人认领);「⤴ 回填表单」= 润色版带回表单继续手改,**非终态**(不保存、工单继续);「↻ 续审」= 手改版 POST `/review/<ticket>/resubmit` 交回本单;「采纳」= 反向翻译回填表单 + force 覆盖保存 + 工单 adopted;「放弃」= discarded。工单跨页面重开可恢复(/env 对账 + 右下角浮动 chip)。**活单恢复路径**:页面重开即自动恢复最新一张,收口后刷新恢复下一张;页面橙色横幅提示 serve 代码过期(stale)时,收口当前轮后重启 `node E:\power-luna\src\org.mjs serve` 再继续。
6. **收口**:会话里跑 `node E:\power-luna\src\org.mjs check` 复核红警清零;回执确认。

## 约定

- 文件名 = agent id = 岗位名,英文单名制(已裁定);撞名必拒。
- **@xxx 技能引用一律译成「用 skill 工具加载 xxx skill」写进工具知识**——模型不主动调技能,也能照章调用。
- 只引用已装配能力:引用未装配的工具名,check 会红警点名该岗——先补装配或改设计。
- 职责与在编岗重叠时如实报,不擅自合并。
- 改岗 = 编制现状卡点岗载入,表单全字段回填,**锁名**(改名 = 新建 + 撤岗两步走,不做表单内改名);调边(调归属)= 表单「归属」多选,保存即改写 org edges,可多父;撤岗 = 改岗横幅「撤岗」:删文件 + 出编 + 两端清边,原下属自动变根岗。设计定案仓库 docs/design/edit-loop.md。
- **编制蓝图 = 预设计稿**(blueprint.json,与编制 org.json 并存):岗位可无文件,按需先行、不挡直接造岗;蓝图永不回写 org——岗落地走蓝图卡「造此岗」预填表单 + 既有 /save 入编(不做批量一键落地,正文是岗位的灵魂,逐岗施工逐岗裁决);已落地岗在蓝图卡锁名,调边仍走改岗表单。设计定案仓库 docs/design/blueprint.md。
