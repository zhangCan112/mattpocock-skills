// skill-trail 持久层状态机直测(store.ts / TrailStore,2026-11-04 治理轮深化搬迁配套)。
// 两个 adapter 坐实 seam:生产 = index.ts 从 SDK ctx.storage 装配,测试 = 本件内存 fake。
// 覆盖面:init 恢复/降级、落账闸(明细 durable 才计数)、LRU 逐出、被逐出会话水合不双计、
//   落盘串行链快照超集、累计层读-改-写(读失败留队/折叠一次写/写失败读时投影)、
//   扫频限流与冷会话基线、触发情境回填窗口、启动清理三动作。
import { test } from "node:test"
import assert from "node:assert/strict"
import { TrailStore, type TrailStoreIO } from "./store.ts"
import { obj, type SkillRecord } from "./trail.ts"

const rec = (ts: number, skillID: string, extra?: Partial<SkillRecord>): SkillRecord => ({
  ts, skillID, trigger: "model", ...extra,
})

/** 内存 adapter:storage(data)+ 会话转录(transcripts)+ 探针/调用记录 + 可拨时钟 */
function fakeIO(initial?: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}))
  const transcripts = new Map<string, unknown>()
  const probes: Array<Record<string, unknown>> = []
  const setCalls: Array<{ key: string; value: unknown }> = []
  const removeCalls: string[] = []
  const failKeys = { get: new Set<string>(), set: new Set<string>() }
  const clock = { t: 1_000 }
  const io: TrailStoreIO = {
    get: async (key) => {
      if (failKeys.get.has(key)) throw new Error(`get(${key}) 失败`)
      return data.get(key)
    },
    set: async (key, value) => {
      if (failKeys.set.has(key)) throw new Error(`set(${key}) 失败`)
      setCalls.push({ key, value })
      data.set(key, value)
    },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix) && (!after || k > after)).sort()
      const page = keys.slice(0, limit)
      const last = page[page.length - 1]
      return {
        entries: page.map((key) => ({ key, value: data.get(key) })),
        ...(keys.length > page.length && last ? { next: last } : {}),
      }
    },
    remove: async (key) => {
      removeCalls.push(key)
      data.delete(key)
    },
    sessionContext: async (sid) => transcripts.get(sid),
    probe: (entry) => { probes.push(entry) },
    now: () => clock.t,
  }
  return { io, data, transcripts, probes, setCalls, removeCalls, failKeys, clock }
}

type Fake = ReturnType<typeof fakeIO>

/** 微任务排干:store 的串行链/水合/落账全为纯 promise 链(fake 立即兑现,无定时器) */
async function drain(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

function statTotal(f: Fake, skillID: string): number {
  const raw = obj(obj(f.data.get("stats:totals"))[skillID]).total
  return typeof raw === "number" ? raw : 0
}

const userMsg = (at: number, text: string, skills: Array<{ id: string; name?: string }> = []) => ({
  type: "user", time: { created: at }, parts: [{ text, ...(skills.length ? { skills } : {}) }],
})

// ---------- init(累计层恢复 + 装载自证) ----------

test("init 恢复累计层并打 setup.done 自证线", async () => {
  const f = fakeIO({ "stats:totals": { alpha: { total: 3, userTriggers: 1, modelTriggers: 2, errors: 0, firstUsedAt: 1, lastUsedAt: 2 } } })
  const store = new TrailStore(f.io)
  await store.init()
  await drain()
  const done = f.probes.find((p) => p.hook === "setup.done")
  assert.ok(done, "setup.done 探针缺席")
  assert.equal(done.totalsSkills, 1)
  assert.equal(done.storageSessions, 0)
})

test("init 读失败降级空账(不抛,明细层照常)", async () => {
  const f = fakeIO({ "stats:totals": { alpha: { total: 3, userTriggers: 0, modelTriggers: 3, errors: 0, firstUsedAt: 1, lastUsedAt: 2 } } })
  f.failKeys.get.add("stats:totals")
  const store = new TrailStore(f.io)
  await store.init()
  await drain()
  const done = f.probes.find((p) => p.hook === "setup.done")
  assert.ok(done)
  assert.equal(done.totalsSkills, 0)
})

// ---------- commit:落账闸 + 落盘 ----------

test("commit 差分计数 → 明细落盘 + 累计落账(持久化成功才计数)", async () => {
  const f = fakeIO()
  const store = new TrailStore(f.io)
  await store.init()
  store.commit("s1", [rec(1000, "alpha", { callID: "c1" })])
  await drain()
  assert.deepEqual(f.data.get("trail:s1"), [rec(1000, "alpha", { callID: "c1" })])
  assert.equal(statTotal(f, "alpha"), 1)
})

test("落账闸:明细持久化失败 → 计数扣留;下次成功全量释放", async () => {
  const f = fakeIO()
  f.failKeys.set.add("trail:s1")
  const store = new TrailStore(f.io)
  await store.init()
  store.commit("s1", [rec(1000, "alpha", { callID: "c1" })])
  await drain()
  assert.equal(statTotal(f, "alpha"), 0, "明细未 durable 就计数了")
  f.failKeys.set.delete("trail:s1")
  store.commit("s1", [rec(1000, "alpha", { callID: "c1" }), rec(2000, "alpha", { callID: "c2" })])
  await drain()
  assert.equal(statTotal(f, "alpha"), 2, "一次成功应释放全部扣留增量")
  const stored = obj(f.data.get("trail:s1"))
  assert.equal(Array.isArray(stored) ? stored.length : 0, 2)
})

// ---------- LRU + 水合 ----------

test("LRU 逐出最旧会话;当前会话绝不逐出", async () => {
  const f = fakeIO()
  const store = new TrailStore(f.io, { sessionsInMemory: 2 })
  store.commit("s1", [rec(1, "a")])
  store.commit("s2", [rec(2, "b")])
  store.commit("s1", [rec(1, "a"), rec(3, "a")]) // 刷新 s1 热度 → LRU 序:s2, s1
  store.commit("s3", [rec(4, "c")]) // 超限 → 逐出 s2(不是 s1)
  await drain()
  assert.equal(store.recordsOf("s2").length, 0)
  assert.equal(store.recordsOf("s1").length, 2)
  assert.equal(store.recordsOf("s3").length, 1)
})

test("冷会话再到来:增量先落盘,水合合并不双计", async () => {
  const f = fakeIO({ "trail:s1": [{ ts: 100, skillID: "alpha", trigger: "user" }] })
  const store = new TrailStore(f.io, { sessionsInMemory: 1 })
  await store.init()
  store.commit("s1", [rec(1000, "alpha", { callID: "c1" })]) // 冷会话:差分只计新记录
  await drain()
  assert.equal(store.recordsOf("s1").length, 2, "storage 旧记录 + 内存增量应合并")
  assert.equal(statTotal(f, "alpha"), 1, "水合恢复的旧记录不应重复计数")
})

// ---------- 落盘串行链 ----------

test("落盘串行链:执行时读最新快照,写入单调不回退", async () => {
  const f = fakeIO()
  const store = new TrailStore(f.io)
  await store.init()
  store.commit("s1", [rec(1000, "a", { callID: "c1" })])
  await drain()
  store.commit("s1", [rec(1000, "a", { callID: "c1" }), rec(2000, "a", { callID: "c2" })])
  await drain()
  const writes = f.setCalls.filter((c) => c.key === "trail:s1").map((c) => {
    const v = c.value
    return Array.isArray(v) ? v.length : -1
  })
  assert.deepEqual(writes, [1, 2], "先落 1 条再落 2 条(超集),绝不回退")
})

// ---------- 累计层读-改-写 ----------

test("落账读失败整批留队不盲写;恢复后折叠一次写回", async () => {
  const f = fakeIO()
  f.failKeys.get.add("stats:totals")
  const store = new TrailStore(f.io)
  await store.init() // 恢复也被拒 → 空账(降级语义)
  store.commit("s1", [rec(1000, "a", { callID: "c1" })])
  await drain()
  assert.ok(f.probes.some((p) => p.hook === "totals.flush.read-failed"))
  assert.equal(f.data.has("stats:totals"), false, "读失败不得盲写覆盖")
  f.failKeys.get.delete("stats:totals")
  store.commit("s1", [rec(1000, "a", { callID: "c1" }), rec(2000, "a", { callID: "c2" })])
  await drain()
  assert.equal(statTotal(f, "a"), 2, "留队的两个 delta 应折叠补落")
  assert.equal(f.setCalls.filter((c) => c.key === "stats:totals").length, 1, "恢复后一次写回")
})

test("落账写失败 delta 留队;reportTotals 读时投影 = storage 新鲜态 + 未落账", async () => {
  const f = fakeIO({ "stats:totals": { alpha: { total: 3, userTriggers: 0, modelTriggers: 3, errors: 0, firstUsedAt: 1, lastUsedAt: 2 } } })
  f.failKeys.set.add("stats:totals")
  const store = new TrailStore(f.io)
  await store.init()
  store.commit("s1", [rec(1000, "alpha", { callID: "c1" })])
  await drain()
  assert.ok(f.probes.some((p) => p.hook === "totals.flush.failed"))
  assert.equal(statTotal(f, "alpha"), 3, "storage 存量不应被写失败改动")
  const rt = await store.reportTotals()
  assert.equal(rt.alpha?.total, 4, "存量 3 + 未落账 1")
})

// ---------- sweep(对账/限流/冷会话基线) ----------

test("sweep 对账补盲:@mention 从 transcript 成账;限流窗口内跳过;无变化零写入", async () => {
  const f = fakeIO()
  f.transcripts.set("s1", [userMsg(1000, "用 @alpha 查一下", [{ id: "alpha", name: "Alpha" }])])
  const store = new TrailStore(f.io)
  await store.init()
  store.sweep("s1", "session.execution.succeeded")
  await drain()
  assert.equal(store.recordsOf("s1").length, 1)
  assert.equal(store.recordsOf("s1")[0]!.trigger, "user")
  assert.equal(statTotal(f, "alpha"), 1)
  assert.ok(f.probes.some((p) => p.hook === "sweep.committed"))
  const writesAfterFirst = f.setCalls.length
  f.clock.t = 2000 // 窗口内(< 60s)→ 限流跳过
  store.sweep("s1", "session.execution.succeeded")
  await drain()
  assert.equal(f.probes.filter((p) => p.hook === "sweep.committed").length, 1)
  f.clock.t = 61_001 // 过窗口 → 重评,无变化零写入
  store.sweep("s1", "session.execution.succeeded")
  await drain()
  assert.equal(f.setCalls.length, writesAfterFirst, "无变化不得写盘")
  f.clock.t = 121_002 // 再过窗口 + transcript 有新 mention → 再成账
  f.transcripts.set("s1", [
    userMsg(1000, "用 @alpha 查一下", [{ id: "alpha", name: "Alpha" }]),
    userMsg(120000, "再来一次 @alpha", [{ id: "alpha" }]),
  ])
  store.sweep("s1", "session.execution.succeeded")
  await drain()
  assert.equal(store.recordsOf("s1").length, 2)
  assert.equal(statTotal(f, "alpha"), 2)
})

test("sweep 冷会话先取 storage 基线,旧账不双计", async () => {
  const f = fakeIO({ "trail:s1": [{ ts: 100, skillID: "alpha", trigger: "user" }] })
  f.transcripts.set("s1", [
    userMsg(100, "用 @alpha", [{ id: "alpha" }]),
    userMsg(500, "再 @alpha", [{ id: "alpha" }]),
  ])
  const store = new TrailStore(f.io)
  await store.init()
  store.sweep("s1", "session.execution.succeeded")
  await drain()
  assert.equal(store.recordsOf("s1").length, 2)
  assert.equal(statTotal(f, "alpha"), 1, "ts=100 旧账已计过,只计新增 ts=500")
})

// ---------- enrich(触发情境回填) ----------

test("enrich 窗口内回填触发情境;窗口外不动", async () => {
  const f = fakeIO()
  f.transcripts.set("s1", [userMsg(995, "请用 alpha 处理这事")])
  const store = new TrailStore(f.io)
  await store.init()
  store.commit("s1", [rec(1000, "alpha", { callID: "c1" })])
  store.enrich("s1", "alpha", 1000) // 1000 - 1000 = 0s ≤ 15s 窗口
  await drain()
  assert.equal(store.recordsOf("s1")[0]!.prompt, "请用 alpha 处理这事")
  store.commit("s2", [rec(1000, "beta", { callID: "c9" })])
  f.transcripts.set("s2", [userMsg(16500, "迟到的消息")])
  store.enrich("s2", "beta", 17000) // 17000 - 1000 = 16s > 15s 窗口
  await drain()
  assert.equal(store.recordsOf("s2")[0]!.prompt, undefined)
})

// ---------- prune(启动清理) ----------

test("prune 启动清理:删畸形、删超限最旧、截尾超长", async () => {
  const f = fakeIO({
    "trail:bad": "not-an-array",
    "trail:old": [rec(1, "x")],
    "trail:new": [rec(2, "x"), rec(3, "x"), rec(4, "x")],
  })
  const store = new TrailStore(f.io, { sessionsInStorage: 1, recordsPerSession: 2 })
  await store.init()
  await store.prune()
  assert.ok(f.removeCalls.includes("trail:bad"), "畸形条目应删除")
  assert.ok(f.removeCalls.includes("trail:old"), "超限最旧会话应删除")
  assert.ok(!f.removeCalls.includes("trail:new"), "最新会话应保留")
  const kept = f.data.get("trail:new")
  assert.ok(Array.isArray(kept))
  assert.deepEqual(kept.map((r) => obj(r).ts), [3, 4], "超长历史截尾保新")
})

// ---------- scanTrail(明细层扫描) ----------

test("scanTrail 只认本前缀,畸形值进 malformedKeys", async () => {
  const f = fakeIO({
    "trail:s1": [rec(1, "a")],
    "trail:s2": [rec(2, "a")],
    "trail:bad": 7,
    "other:x": 1,
  })
  const store = new TrailStore(f.io)
  await store.init()
  const { sessions, malformedKeys } = await store.scanTrail()
  assert.deepEqual(sessions.map((s) => s.sid).sort(), ["s1", "s2"])
  assert.deepEqual(malformedKeys, ["trail:bad"])
})
