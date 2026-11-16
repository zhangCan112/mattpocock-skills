# SYNCED.md —— 部署指纹

- 来源仓库:`E:\opencode-plugins-v2`(分支 main)
- 来源 commit:`5ad3e33`(= 同步时 HEAD,工作树干净,无未提交修改)
- 版本:**0.6.0**(治理轮深化:index.ts 里不可测的持久化状态机整体搬入
  `store.ts`(TrailStore 深模块,TrailStoreIO 注入——生产 adapter 从 SDK ctx.storage
  装配,内存 fake 直测),LRU 逐出 / 按会话串行落盘 / 增量落账闸 / 累计层读-改-写 /
  扫频限流 / 冷会话水合 / 启动清理全部入模块,14 个 node --test 直测;行为语义
  与 v0.5.1 落账闸一致,仅结构搬迁。GLOSSARY.md(域词表)+ 根 GLOSSARY-MAP.md 首建)
- 同步方式:`robocopy /MIR /XD node_modules`(2026-11-04;退出码 <8 为成功;
  /MIR 清掉上一份 SYNCED.md 后本文件重写——非错误)
- 同步后必须**重启 opencode server + 重开 TUI**——ESM 模块缓存,watcher reload
  不清缓存,半新半旧组合会以 named export not found 静默禁用插件
- v0.6.0 对版特征:`/plugins` 面板 skill-trail 版本 0.6.0;`SKILL_TRAIL_PROBE=1`
  时探针文件出现 `setup.done` 行(storageSessions/totalsSkills 与旧版同源);
  行为面与 0.5.1 无差异(纯结构重构,对版以版本号 + 本文件 commit 为准)
- store.ts 尚无 mac 实测(代码全走 node:path/node:os 跨平台面,store.test.ts
  零平台耦合;与既有件同静态审查口径)
