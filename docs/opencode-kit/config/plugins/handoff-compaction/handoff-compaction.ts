// handoff-compaction plugin —— 交接式压缩 / 同一 Agent 的新陈代谢（压缩也是一种交接：
// 把历史换血成写给遗忘后的自己的结构化便签，腾出上下文空间继续工作；改名轮
// auto-handoff → handoff-compaction，auto-handoff 名字让给跨会话接力件）
// 本文件 = 接线层：compaction hook 接管 + 事件总线订阅。纯逻辑（六段模板 / 转录压缩 /
//   smart-zone 水位 / 摘要落盘）在 compaction.ts——IO 注入，node --test 直测
//   （skill-trail 的 trail.ts 同款分层）。
// 纯 V2 形态（API 面按 @opencode/plugin 2.2.3 tarball .d.ts 实证）：
//   session.hook("compaction") 接管：event.result 直接采用，跳过内置摘要调用；
//   事件总线 event.subscribe：session.step.ended 驱动 smart-zone 水位（单步 tokens =
//   当次请求上下文；usage.updated 是计费累计、压完不回落——v0.5.0 误用酿成全局无限
//   压缩事故，v0.5.1 弃用，宿主 usage.ts SessionUsage.add 累加器实证。V1 的
//   message.part.updated/step-finish 在 2.x 类型面零命中，整段死亡）；
//   session.compaction.ended 载荷 data.text 即摘要全文——无需再拉 session.context。
//   backend Context 无 toast 面（考证）：提醒与落盘提示一律 console.log。
// 接管模型链：models.json 的 active profile worker 档（项目 .opencode/ 优先、src/ 回落、
//   全局 ~/.config/opencode/models.json 键级回落——v0.22.0）优先，压缩事件自带模型
//   （SessionRequest.model——宿主为本次压缩已选好的模型）兜底——无 models.json 的项目也
//   全情接管；两路皆空 / 全部候选生成失败才降级为默认压缩（查不阻断）
// 调试探针：HANDOFF_COMPACTION_PROBE=1 → tmpdir/opencode-handoff-compaction-probe.jsonl
//   （事件形状 dataKeys/tokKeys、阈值来源、hook 结局、落盘结局——console.log 不进 --print-logs）
// 风格（2026-11-03 轮）：对齐 Google TypeScript Style Guide——任意型零手写（宿主面吃 SDK
//   Plugin.Context，动态载荷 unknown + obj/str 收窄），行为不变。
// smart-zone 线（2026-11-03 轮）：缺省水位 150k → 100k——对齐 Matt Pocock 的
//   smart zone / dumb zone 实践（约 100k 注意力劣化拐点，与窗口大小无关，出处见
//   compaction.ts 的 DEFAULT_SMART_ZONE 注）；其余行为不变。
// v0.5 主动触发（2026-11-03 轮）：过线不再只提醒——插件直接 ctx.session.compact()
//   发起压缩（SDK 2.2.5 SessionDomain Pick 含 compact）。为什么必须插件触发：宿主
//   buffer 表达不了跨窗口绝对线——百分比 buffer 跟窗口走（1M 窗口 "20%"=800k 才压），
//   绝对 buffer 在窗口 ≤ buffer 时被宿主忽略回落 15%；跨窗口的绝对 100k 线只能插件
//   在 usage 侧自判自触发，宿主 buffer（如 "50%"）降级为兜底。阈值双形态：
//   smart_zone_tokens: 100000（绝对）| "10%"（触发点 = 会话当前模型窗口 × pct，
//   窗口经 session.get().model + model.list() limit.context 解析，失败回落绝对缺省）。
//   状态机：滞回（过线至 ended/failed 发起一次）+ in-flight 防抖（started→ended/failed
//   不再发起）+ ended 再武装清峰值 / failed 再武装保峰值；compact 抛错回落旧提醒文案。
//   delivery 初版不传（吃宿主缺省，真机冒烟后再议）。设计文档：docs/spec-smart-zone-auto-compact.md
// v0.5.1 计量修正（2026-11-03 事故轮）：触发信号 usage.updated → session.step.ended
//   （单步 input+cache，压缩后随上下文回落）；新增压缩底座护栏（ended 后首个 step 记
//   底座，线 ≤ 底座 → 拦截 + 单次 log，防小绝对线 / 小窗百分比线无限压缩）。根因取证
//   见 docs/spec-smart-zone-auto-compact.md §10 补记。
// v0.6.0 缺省线回调（2026-11-03 用户拍板）：DEFAULT_SMART_ZONE 100k → 150k——v0.5.1 计量
//   修正后线对照真实单步上下文，150k 在 Matt 词典 dumb-zone 起点带（125k–150k）上缘、
//   200k 窗口留 50k 余量；其余行为不变（出处注见 compaction.ts 常量上方）。
// v0.7.0 defer-until-settled（2026-11-03 宽判据用户拍板）：会话存在在飞工作——自身回合
//   （session.execution.started→succeeded/failed/interrupted + retry.scheduled 待发）、
//   任一后代子代理、自有 shell（前台工具 shell + 用户 ! 命令，shell.created/exited 与
//   session.shell.started/ended 双事件族按 shellID 幂等合流）、直接父回合（前台子代理
//   完结瞬间父正读其结果，压缩换摘要会污染读取）——任一在飞则推迟发起（探针 defer-busy
//   + 单次 log），完结事件沿祖先后代链重评补发起；无限等待不设上限（溢出兜底交宿主
//   buffer）。父子关系 session.created.parentID 免费学、重启后先见事件的会话经
//   session.get 懒学一次（失败不缓存自愈）；session.status/idle 类型清单存在但宿主从不
//   发布，弃用。状态机细节见 compaction.ts 的 Watcher 段注；定夺记录见 spec §12。
// v0.8.0 keep 归零理念（2026-11-03 用户定调）：插件理念 = 六段 handoff 摘要完全替代宿主
//   压缩的保留尾巴（compaction.keep.tokens 缺省 15k 原文），使用本插件时配 0——摘要与
//   尾巴装的是同一批信息，双保留=压缩后窗口重复计费 + 底座抬高（每轮 smart-zone 少腾
//   ~15k）。考证结论：插件面无控制点（hook 事件 result 只换摘要、compact() 入参与
//   ConfigApi 均无 keep 字段——官方文档明说 native 压缩也照样保留 keep 段），配置是唯一
//   落地形态，指引见 README「keep 归零」节。行为零变更（文档+注释轮）。
// v0.9.0 定位独立化轮（2026-11-03 用户定调）：拆「交接家族」叙事——本件 = 同一 Agent
//   的新陈代谢（受众：遗忘后的自己，续跑视角），auto-handoff = Agent 之间的接棒（受众：
//   接棒的下一位，跨会话可跨岗）。两件零运行时耦合（互不 import、模板各自持有副本），
//   六段模板同源（handoff skill）但各自独立演进、无对齐义务。行为零变更（注释+文档轮）。
// v0.10.0 TUI 状态栏轮（2026-11-03 用户需求）：新增 tui.tsx 部件（package exports "./tui"，
//   宿主随 server 部件成对装载，skill-trail 同款）——右侧栏 sidebar.content 槽 prepend
//   （边界内首位，恒居 skill-trail 的 append 之上、不依赖装载序）单行展示会话压缩足迹：
//   已压缩 N 次（M 次失败）· 最近 HH:MM · 压缩进行中…。数据源 = transcript 的
//   type:"compaction" 消息（compactionTally/formatCompactionLine 纯函数），不读 server
//   storage（部件间命名域不保证共享）；无压缩痕迹返回 null 不占位。tsconfig include 不含
//   tui.tsx（TUI peer 类型不装，skill-trail 同款；jsx 选项已备）。server 件行为零变更。
// v0.11.0 模板口吻轮（2026-11-03 用户拍板）：HANDOFF_TEMPLATE 正文换成英文、口吻对齐压缩
//   受众——写给遗忘后的同一个会话（this same session after compaction，续跑视角，
//   v0.9.0 定位的正文落地），不再写给「下一个全新会话」；规则句采用 Matt Pocock handoff
//   skill 上游原版（no-duplication 句逐字；redact 句仅限定词改 all——风格门禁，语义
//   不变；四处偏离清单见 compaction.ts 模板注）；六段骨架与中文标题（本仓库自有契约）
//   保留。行为变更 = 生成提示词文本本身。
// v0.12.0 token 计费累计行（2026-11-03 用户需求）：TUI 状态栏加第二行「累计 N tokens」
//   ——数据源 = transcript 的 assistant 步 tokens 五字段累加（sessionTokensTotal /
//   formatTokensLine 纯函数），只增不减、压缩不重置的账单口径（与宿主 SessionUsage.add
//   累加器同口径——v0.5.0 事故源，用作计费展示正确、用作水位错误）；与上下文水位
//   （最后一次压缩后的最新 assistant 步，官方 lastAssistantWithUsage 口径）刻意区分，
//   水位归 smart-zone 叙事不进本栏。server 件行为零变更。
// v0.13.0 TUI 文案英文化（2026-11-04 用户需求）：状态栏标题与两行文案从中文换成英文
//   ——`── Compaction ──` / `Compacted N times (M failed) · last HH:MM · compacting…`
//   （单复数：1 time / N times）/ `Total N tokens`。行为零变更（纯文案轮）；已知取舍：
//   skill-trail 侧栏标题仍是中文（── skill 足迹 ──），右侧栏两栏中英并排——统一与否
//   待真机冒烟后再议。（2026-11-04 补记：用户已拍板统一——skill-trail v0.5.0 侧栏
//   同步英文化，── skill footprint ── / (you/auto)，见 skill-trail 仓库改动。）
// v0.14.0 武装-待续（2026-11-04 用户拍板）：触发时机从「完结即压」改为「下次继续会话时
//   先压再跑」——完结过线只武装（探针 armed + 单次 log，会话可能就此关闭，摘要不白写），
//   用户下条消息落 inbox 前经 prompt admission hook 先 compact()（宿主保证压缩排在仍在
//   等待的 prompt 之前——官方文档 Manual compaction: runs at the next safe point,
//   before prompts that are still waiting），新回合跑在「摘要 + 新消息」上。prompt 入场有
//   在飞工作 → hold-armed 让路；发起失败 → 重武装下条 prompt 重试（非永久降级）；非
//   prompt 驱动续跑（重试/synthetic）不发射，溢出兜底仍交宿主 buffer；hook 注册失败 →
//   promptHookLive 保持 false，降级回 v0.13 完结即压。六段模板/计量/defer 判据均不变。
//   （2026-11-04 补记：真机使用一晚即证伪——用户两轮困惑「怎么没压/只有我发消息才压」，
//   自动压缩的确定性本身是价值，为低频「摘要白写」牺牲它是负交换，v0.15.0 整层删除。）
// v0.15.0 回退：武装-待续删除，恢复 v0.13 完结即压（2026-11-04 用户拍板）。逻辑层删
//   #armed/#armedLogged/#promptHookLive 三态与 onPromptAdmission/promptHookLive 两方法
//   及 #tryFire 武装分支、三处 armed 守卫；接线层删 prompt hook 注册。触发语义回到
//   v0.7.0 defer-until-settled + v0.13 完结即压：在飞推迟、全部完结立即发起。六段模板/
//   TUI/计量/底座护栏均不变。定夺记录见 docs/spec-smart-zone-auto-compact.md §14。
// v0.16.0 用户中断取消（2026-11-04 用户报告「Esc 中断会话后压缩仍自动再次触发」）：
//   execution.interrupted 的 reason:"user"（Esc，SDK 事件枚举精确可辨）= 用户喊停——
//   ①推迟中的发起在 Esc 触发的完结重评里不再放行（原缺陷①：Esc=完结=立即压）；
//   ②在飞压缩被 Esc 掐掉的 compaction.failed 不再 rearm 重试（原缺陷②：用户取消被当
//   瞬态失败，下个完结自动再压）。滞回保持占用 = 本轮降级为提醒语义（与 compact 抛错
//   降级同款），单次取消说明给手动出路；粘至下次压缩成功结算（rearm resetPeak 翻篇）
//   才恢复自动，溢出兜底仍由宿主 buffer 承担。非 user 中断（shutdown/superseded/
//   inactivity）行为不变。状态机新增 #userCancelled/#cancelLogged 两态，#tryFire 头部
//   取消闸门为双路（step.ended / 完结重评）公共收口。定夺记录见 spec §15。
// v0.17.0 完结态终答原文保全（2026-11-04 用户拍板）：压缩时刻末条 assistant 为纯文本
//   （无工具部件、非提问未答）= 回合终答——交接文档在六段后机械追加第七段「最终交付
//   （原文保全）」，逐字原文由插件拼接而非生成器转述（改写/截断正是要防的失效模式），
//   不设长度上限；生成侧仅加一行指令（FINAL_ANSWER_NOTE：六段内引用不复述，防摘要+尾巴
//   之外再添第三份）。工作中态（末条带 tool 部件 / user 未答 / 空转录）分文不加，维持
//   六段原样。判定纯结构、不猜内容（「像不像总结」是猜，spec §14 教训）；与宿主尾巴
//   （永远保最新一条，keep=0 亦然——v2.2.5 源码考证）构成双保险，代价 = 终答在压后
//   上下文计费两份（README「keep 归零」节）。四点拍板：机械拼接/文末/不设限/段名。
//   定夺记录见 docs/spec-smart-zone-auto-compact.md §16。
// v0.18.0 口吻受众回退 Matt 原味（2026-11-04 用户拍板）：v0.11.0 的「写给压缩后的同一
//   会话」被证伪——token 零结转，压缩后除摘要+尾巴外一无所有，「同一个会话」只是宿主层
//   叙事（session id / 盘上转录 / TUI 线程），对当局者（继续工作的那个脑子）而言就是
//   新脑子。开篇受众句回归 Matt 原版逐字（so a fresh agent can continue the work）；
//   第六段「建议 skill」说明句受众同步 the next agent（新脑子第一次装载，非「再装
//   装载」）；live thread 内容焦点与六段骨架不变。v0.9.0 定位（同会话新陈代谢，与
//   auto-handoff 的分工）不动——变的是读者模型照机制事实写。口吻锁测试反向：v0.11.0
//   三处同会话表述必须绝迹。定夺记录见 spec §17。
// v0.19.0 触发层整体删除、时机归宿主原生配置（2026-11-04 用户拍板，已于 v0.20.0 回退）：
//   v0.5–v0.18 的 smart-zone 自算水位主动压缩（step.ended 计量 / 滞回 / in-flight 防抖 /
//   再武装 / 底座护栏 / defer-until-settled / 用户中断取消）五轮补丁仍复刻不出宿主 due()
//   的请求间隙安全点判定——外部事件面拼不出人家跟窗口走、贴着请求边界压的效果，放弃
//   自制。同类效果改由宿主 compaction 配置落地：compaction.buffer 百分比按模型窗口
//   折算落点（1M 窗口配 "85%" = 150k 处压，窗口→百分比表见 README），keep.tokens 保持 0。
// v0.20.0 回退 v0.19.0，smart-zone 触发层原样回归（2026-11-04 用户拍板）：原生百分比方案
//   在混窗口舰队上破产——百分比是静态全局值，换模型不重算：给 1M 配 "85%"（=150k）落到
//   GPT 系 200k 窗口 = 30k 就压、128k 窗口 ≈19k 接近底座；绝对值形态落点同样跟窗口走且
//   窗口 ≤ buffer 被宿主忽略。宿主没有任何形态能表达跨窗口恒定的绝对 150k 线——这正是
//   v0.5 当年自做的理由，绕一圈实证回来。v0.18.0 触发语义（完结即压 + defer + Esc 取消
//   + 底座护栏）整体回归，含已证的取舍：回合末压可能「摘要白写」（v0.14/v0.15 已证伪
//   武装-待续，确定性优先）——v0.17.0 终答原文拼接让该时刻无损。宿主 buffer 回归不配
//   （缺省 15% 兜底，任何窗口都在 150k 线之上、插件先压）。定夺记录见 spec §19。
// v0.21.0 defer-until-settled 整层拆除（2026-11-04 用户拍板「我要可以自动压的」）：v0.7.0
//   的在飞推迟（自身回合/自有 shell/后代子代理/直接父回合任一在飞即推迟、完结补发起、
//   无限等待）在长自主回合上把绝对线架空——活不停就永不压，上下文一路涨到宿主兜底才
//   动手。拆后过线的那个 step 一结算即 compact()（宿主承诺排在下一安全点、先于等待中
//   的 prompt——spec §13 API 考证），在飞现场由六段模板第三段「the live thread」承接
//   （本就为该状态设计）；v0.17 终答拼接只认完结态，进行态压缩不加第七段。defer 全套
//   状态（busy/parent/parentChecked/shellSids/shells/deferLogged）与事件面（created /
//   execution.started|succeeded|failed / retry.scheduled / shell 四条）随拆——
//   execution.interrupted 保留（Esc 取消判别，v0.16 语义不变）。滞回 / in-flight 防抖 /
//   底座护栏 / ended-failed 再武装全部保留。定夺记录见 spec §20。
// v0.22.0 models.json 全局层（2026-11-05 用户需求「这个 models.json 要求全局和项目都能
//   生效，并且项目的值可以覆盖全局」）：配置链扩为三层——项目 .opencode/models.json >
//   项目 src/models.json > 全局 ~/.config/opencode/models.json（与全局 opencode 配置同
//   目录，路径经 WatcherIO.globalModelsPath 注入，homedir 跨平台）。**键级回落**：项目
//   文件在场但缺键 / 键非法时，该键落到全局层取；项目同键有效值覆盖全局（非法值视同
//   缺键，不构成覆盖）。worker.{model,variant} 与 smart_zone_tokens 同链同规（workerModelOf/
//   smartZoneOf 两提取器同构）。动因：用户要把全部项目的线从 150k 提到 180k——此前配置
//   点只有项目层，内置缺省 150k 又锚在源码里，「一处配好、处处生效、项目可覆盖」没有
//   落地形态。内置缺省 150k 保持末位兜底。探针 threshold 新增 source:"global"（项目绝对
//   值仍 "disk"）。缓存口径不变：任一层命中即按 cwd 缓存，全链落空不缓存。定夺记录见
//   spec §21。
// v0.23.0 按 Agent / 按模型配置（2026-11-05 用户定调六档链「项目 agent > 项目按模型 >
//   项目兜底 > 全局按模型 > 全局兜底 > 插件默认」）：层内新增两档——①agents.<name>
//   （**项目层专属键**，全局层不读）：按会话 Agent 配线，如 agents.explore 配更紧的线
//   给检索岗；②profiles.models 匹配池：profile 携 models: ["provider/id"] 精确串
//   （声明序首个命中，variant 不参与），会话当前模型命中即取该池的线。身份源 =
//   session.get 的 agent?/model?（SDK Session.Info 考证：两字段同源同调、均可选；
//   step.ended 事件载荷不带身份，故逐事件拉取——与百分比窗口同一调用，中途换模型 /
//   换岗即时换线）。缓存键随身份扩为 cwd|模型|agent。双形态（绝对 / 百分比）六档通用；
//   非法值视同缺键越档（v0.22 键级回落语义继承）。探针 threshold 契约重构：source
//   project/global/default + matched agent/model/active（v0.22 的 "disk" 并入 "project"）。
//   worker 档维持 active 单源（本轮只动触发线，生成模型链不扩）。定夺记录见 spec §22。
import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { cap, FINAL_ANSWER_NOTE, finalAnswerOf, HANDOFF_TEMPLATE, modelChain, obj, resolveWorkerModel, str, transcriptOf, withFinalAnswer, Watcher, type ModelCandidate, type ModelRef, type WatcherIO } from "./compaction.ts"

// 调试探针（skill-trail 同款）：HANDOFF_COMPACTION_PROBE=1 时逐事件 append JSONL 到
// tmpdir/opencode-handoff-compaction-probe.jsonl。console.log 不进 --print-logs，冒烟验证走探针文件
const PROBE_ENV = "HANDOFF_COMPACTION_PROBE"
const PROBE_FILE = "opencode-handoff-compaction-probe.jsonl"

function probe(entry: Record<string, unknown>): void {
  if (process.env[PROBE_ENV] !== "1") return
  try {
    appendFileSync(join(tmpdir(), PROBE_FILE), JSON.stringify(entry) + "\n", "utf8")
  } catch {
    // 探针失败静默：观测件绝不影响主流程（行为差异点：Windows 下探针文件被别的进程
    // 独占打开（如编辑器查看中）时 append 会 EBUSY——平台文件锁差异，跳过该行即可）
  }
}

export default Plugin.define({
  id: "handoff-compaction",
  async setup(ctx: Plugin.Context) {
    const cwd: string = ctx?.location?.directory ?? process.cwd()
    const io: WatcherIO = {
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, data) => writeFile(path, data, "utf8"),
      tmpRoot: tmpdir(),
      // 全局层 models.json：与全局 opencode 配置同目录（~/.config/opencode/，homedir 跨平台
      // 拼路径——mac / Windows 各自落到用户主目录下的 .config，与 opencode 全局配置布局一致）
      globalModelsPath: join(homedir(), ".config", "opencode", "models.json"),
      log: (message) => console.log(message),
      probe,
      // 主动触发面：域方法缺席（旧宿主）时调用处抛 TypeError，由逻辑层捕获降级回落提醒
      compact: (sessionID) => ctx.session.compact({ sessionID }),
      sessionInfo: (sessionID) => ctx.session.get({ sessionID }),
      modelList: () => ctx.model.list(),
    }
    // smart-zone 水位 + 摘要落盘（事件路）；hook 产出路共用同一实例（persisted 去重）
    const watcher = new Watcher(io)
    try {
      await ctx.session.hook("compaction", async (event) => {
        try {
          const gen = ctx.experimental?.generate ?? ctx?.generate
          // hook 探针基线：每次压缩一条结局线（messages=-1 表示消息面缺失）
          const hookBase = {
            t: "hook" as const,
            messages: Array.isArray(event?.messages) ? event.messages.length : -1,
            sessionID: typeof event?.sessionID === "string" ? event.sessionID : undefined,
            gen: Boolean(gen?.text),
          }
          if (!gen?.text) {
            probe({ ...hookBase, outcome: "degraded", reason: "generate 面不可用" })
            return console.log("[handoff-compaction] 接管降级：generate 面不可用，走默认压缩") // 降级：默认压缩
          }
          if (!Array.isArray(event?.messages)) {
            probe({ ...hookBase, outcome: "degraded", reason: "消息面缺失" })
            return console.log("[handoff-compaction] 接管降级：消息面缺失，走默认压缩")
          }
          // 接管候选链：models.json worker 档优先，压缩事件自带模型（SessionRequest.model，
          // 宿主为本次压缩已选好的模型）兜底——无 models.json 的项目也全情接管
          const chain = modelChain(await resolveWorkerModel(io, cwd), event)
          if (chain.length === 0) {
            probe({ ...hookBase, outcome: "degraded", reason: "worker 档与事件模型均不可用" })
            return console.log("[handoff-compaction] 接管降级：worker 档与事件模型均不可用，走默认压缩")
          }
          // 完结态终答（v0.17.0）：纯结构判定——末条 assistant 纯文本即终答，工作中态 → undefined
          const finalAnswer = finalAnswerOf(event.messages)
          // 完结态追加生成器指令（转录之后）：终答由插件逐字追加，六段内引用不复述
          const prompt = HANDOFF_TEMPLATE + cap(transcriptOf(event.messages)) + (finalAnswer !== undefined ? FINAL_ANSWER_NOTE : "")
          let out: unknown
          let used: ModelCandidate | undefined
          let lastError: unknown
          candidate: for (const cand of chain) {
            // 带 variant 先试，被拒再去 variant 裸试（同候选至多两次；无 variant 只试一次）
            const attempts: readonly ModelRef[] = cand.ref.variant
              ? [cand.ref, { providerID: cand.ref.providerID, id: cand.ref.id }]
              : [cand.ref]
            for (const model of attempts) {
              try {
                out = await gen.text({ model, prompt })
                used = cand
                break candidate
              } catch (e) {
                lastError = e
              }
            }
          }
          if (used === undefined) {
            const tried = chain.map((c) => `${c.ref.providerID}/${c.ref.id}`).join("、")
            probe({ ...hookBase, outcome: "degraded", reason: "全部候选生成失败", models: tried, error: lastError instanceof Error ? lastError.message : String(lastError) })
            return console.log(`[handoff-compaction] 接管降级：全部候选生成失败（${tried}：${lastError instanceof Error ? lastError.message : String(lastError)}），走默认压缩`)
          }
          const summary = str(obj(out).text).trim()
          if (summary) {
            // v0.17.0：完结态把终答原文机械拼接为第七段「最终交付（原文保全）」——拼接先于
            // 接管与落盘，压缩替换段与落盘文件自动同款；工作中态直通（六段原样）
            const doc = withFinalAnswer(summary, finalAnswer)
            event.result = { summary: doc } // 接管；失败则保持默认压缩
            probe({ ...hookBase, outcome: "tookover", model: `${used.ref.providerID}/${used.ref.id}`, source: used.source, summaryLen: doc.length, final: finalAnswer !== undefined ? "spliced" : "none", ...(finalAnswer !== undefined ? { finalLen: finalAnswer.length } : {}) })
            console.log(`[handoff-compaction] compaction 接管：${used.source === "event" ? "事件模型" : "worker"} ${used.ref.providerID}/${used.ref.id} 生成 handoff 摘要（${doc.length} 字${finalAnswer !== undefined ? "，含最终交付原文" : ""}）`)
            // 产出 summary 后落盘（ended 事件路径由 persisted 去重兜底；结局线由 persistSummary 探针记录）
            if (typeof event?.sessionID === "string") {
              try {
                await watcher.persistSummary(event.sessionID, doc)
              } catch (e) {
                console.log(`[handoff-compaction] 落盘降级：${e instanceof Error ? e.message : String(e)}（不影响压缩结果）`)
              }
            }
          } else {
            probe({ ...hookBase, outcome: "degraded", reason: "生成结果为空", model: `${used.ref.providerID}/${used.ref.id}` })
            console.log("[handoff-compaction] 接管降级：生成结果为空，走默认压缩")
          }
        } catch (e) {
          probe({ t: "hook", outcome: "degraded", reason: "未预期异常", error: e instanceof Error ? e.message : String(e) })
          console.log(`[handoff-compaction] 接管降级：未预期异常（${e instanceof Error ? e.message : String(e)}），走默认压缩`) // 降级：默认压缩
        }
      })
    } catch (e) {
      console.log(`[handoff-compaction] hook 注册失败：${e instanceof Error ? e.message : String(e)}——插件不崩，默认压缩兜底`)
    }
    // V2 事件订阅循环喂 watcher.handleEvent（AbortController 模式）
    let cleanup: (() => void) | undefined
    try {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            await watcher.handleEvent(event, cwd)
          }
        } catch {
          // 降级：订阅循环异常不影响 V2 主流程
        }
      })()
      cleanup = () => controller.abort()
    } catch {
      // event.subscribe 不可用：静默降级
    }
    return () => {
      try {
        cleanup?.()
      } catch {
        // 清理失败静默
      }
    }
  },
})
