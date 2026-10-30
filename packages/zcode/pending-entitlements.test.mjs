// Granted entitlements can start before ZCode creates a spendable balance.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

if (![tmpdir(), realpathSync(tmpdir())].some((p) => homedir().startsWith(p))) throw new Error("run in an isolated home")
const { ZCodeAuthPlugin, ZCodeStartAuthPlugin, _internal } = await import("./index.mjs")
const now = Math.trunc(Date.now() / 1000)
const token = ["{}", JSON.stringify({ exp: now + 86400 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".synthetic"
const state = { site: "zai", jwt: token, device: "synthetic-device", key: "synthetic-key", plan: "GLM Coding Pro" }
const auth = { type: "oauth", access: state.key, refresh: JSON.stringify(state), expires: 0 }
const realFetch = globalThis.fetch
const calls = []
const alias = "GLM-5.3-Flash-Trial"
let balance

beforeEach(() => {
  _internal.routes.clear()
  _internal.blocked.clear()
  _internal.config(null)
  calls.length = 0
  // Shape of a granted Weekend Build: active plan, future entitlement,
  // 500M tokens, no balances before effective_at.
  balance = {
    server_time: now,
    plans: [{
      plan_id: "weekend", user_plan_id: "grant-1", name: "ZCODE WEEKEND BUILD",
      status: "active", starts_at: now - 900, ends_at: now + 3 * 86400,
      entitlements: [{
        entitlement_id: "flash", show_name: "GLM-5.3-Flash", unit_type: "token",
        capabilities: ["model:glm-5.3-flash"], grant_units: 500000000,
        period: "one_time", effective_at: now + 3600,
      }],
    }],
    balances: [],
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ path: url.pathname, method: init.method ?? "GET" })
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") return Response.json({ code: 0, data: balance })
    if (url.pathname === "/api/biz/subscription/list") return Response.json({ code: 0, data: [{ productName: "GLM Coding Pro", status: "VALID" }] })
    if (url.pathname === "/api/monitor/usage/quota/limit") return Response.json({ code: 0, data: { limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 25 }] } })
    if (url.pathname === "/api/v1/zcode-plan/billing/preview") return Response.json({ code: 0, data: { plans: [] } })
    throw new Error("unexpected network request: " + url.pathname)
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  _internal.routes.clear()
  _internal.blocked.clear()
  _internal.config(undefined)
})

const start = () => ZCodeStartAuthPlugin({ client: {} })
const normal = () => ZCodeAuthPlugin({ client: {} })
const catalog = (h) => h.provider.models({ models: {} }, { auth })
const usage = (h) => h.auth.usage(async () => auth)
const bucket = (id = "flash") => ({
  plan_id: "weekend", user_plan_id: "grant-1", entitlement_id: id,
  show_name: "GLM-5.3-Flash", capabilities: ["model:glm-5.3-flash"],
  total_units: 500000000, used_units: 50000000, remaining_units: 450000000,
  expires_at: now + 3 * 86400,
})

test("a granted future entitlement is visible without balances and has no routable model", async () => {
  const h = await start()
  const card = await usage(h)
  expect(card.error).toBeUndefined()
  expect(card.plan).toBe("ZCODE WEEKEND BUILD")
  expect(card.windows).toHaveLength(1)
  const w = card.windows[0]
  expect(w.name).toContain("待生效")
  expect(w.display).toContain("500000000 tokens")
  expect(w.display).toContain("生效")
  expect(w.aside).toBe(true)
  expect(w.models).toBeUndefined()
  expect(w.amount).toBeUndefined()
  expect(w.limit).toBeUndefined()
  expect(w.resetsAt).toBeUndefined()
  expect(await catalog(h)).toEqual({})
  expect(calls.every((c) => c.method === "GET")).toBe(true)
})

test("pending entitlement information also appears beside the Pro card without changing its limits", async () => {
  const card = await usage(await normal())
  expect(card.plan).toBe("GLM Coding Pro")
  expect(card.windows[0]).toMatchObject({ name: "Weekly", used: 25 })
  expect(card.windows[0].notModels).toBeUndefined()
  expect(card.windows.at(-1)).toMatchObject({ aside: true })
  expect(card.windows.at(-1).name).toContain("待生效")
  expect(card.windows.at(-1).models).toBeUndefined()
  expect(_internal.routes.get(state.key + "\0" + state.jwt).gift.models).toEqual([])
})

test("a balance created before its entitlement starts cannot be spent or listed", async () => {
  balance.balances.push(bucket())
  const h = await start()
  expect(await catalog(h)).toEqual({})
  expect((await usage(h)).windows).toHaveLength(1)
  expect((await usage(h)).windows[0].aside).toBe(true)
  const loader = await h.auth.loader(async () => auth, { id: "zcode-start" })
  const res = await loader.fetch("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: alias, max_tokens: 1, messages: [{ role: "user", content: "offline test" }] }),
  })
  expect(res.status).toBe(400)
  expect(calls.some((c) => c.path.endsWith("/messages"))).toBe(false)
  expect(Object.keys(await catalog(await normal())).filter((m) => m.endsWith("-Trial"))).toEqual([])
})

test("the start boundary exposes only the real balance and retires the pending note", async () => {
  balance.balances.push(bucket())
  const h = await start()
  expect(await catalog(h)).toEqual({})
  balance.server_time = now + 3600
  const card = await usage(h)
  expect(card.windows).toHaveLength(1)
  expect(card.windows[0]).toMatchObject({
    name: "GLM-5.3-Flash", used: 10, amount: 50000000, limit: 500000000,
    models: ["glm-5.3-flash", alias],
  })
  expect(card.windows[0].aside).toBeUndefined()
  expect(card.windows[0].name).not.toContain("待生效")
  expect(Object.keys(await catalog(h))).toEqual([alias])
})

test("reaching effective_at without a real balance does not invent usable tokens", async () => {
  balance.server_time = now + 3600
  const h = await start()
  expect(await catalog(h)).toEqual({})
  expect((await usage(h)).windows).toEqual([])
})

test("a future plan start takes precedence over a bucket's available count", async () => {
  balance.plans[0].starts_at = now + 7200
  balance.plans[0].entitlements[0].effective_at = 0
  balance.balances.push(bucket())
  const h = await start()
  expect(await catalog(h)).toEqual({})
  expect((await usage(h)).windows[0]).toMatchObject({ aside: true })
})

test("a future bucket period is informational until its own start", async () => {
  balance.plans[0].entitlements[0].effective_at = 0
  balance.balances.push({ ...bucket(), period_start: now + 3600 })
  const h = await start()
  expect(await catalog(h)).toEqual({})
  expect((await usage(h)).windows[0].aside).toBe(true)
})

test("a live sibling stays available when another entitlement is still pending", async () => {
  balance.plans[0].entitlements.push({
    entitlement_id: "live", show_name: "GLM-5.3", capabilities: ["model:glm-5.3"],
    effective_at: 0, grant_units: 1000,
  })
  balance.balances.push({
    ...bucket("live"), show_name: "GLM-5.3", capabilities: ["model:glm-5.3"],
    total_units: 1000, used_units: 250, remaining_units: 750,
  })
  const h = await start()
  expect(Object.keys(await catalog(h))).toEqual(["GLM-5.3-Trial"])
  const card = await usage(h)
  expect(card.windows).toHaveLength(2)
  expect(card.windows[0]).toMatchObject({ name: "GLM-5.3", used: 25 })
  expect(card.windows[0].aside).toBeUndefined()
  expect(card.windows[1].aside).toBe(true)
  expect(card.windows[1].models).toBeUndefined()
})

test("inactive, expired and impossible future grants do not appear as available or pending", async () => {
  for (const status of ["expired", "cancelled", "inactive"]) {
    balance.plans[0].status = status
    expect((await usage(await start())).error).toContain("ended or was never started")
    expect(await catalog(await start())).toEqual({})
  }
  balance.plans[0].status = "active"
  balance.plans[0].ends_at = now + 3600
  balance.plans[0].entitlements[0].effective_at = now + 7200
  expect((await usage(await start())).windows).toEqual([])
})

test("the normal route cache expires no later than the next entitlement start", async () => {
  balance.plans[0].entitlements[0].effective_at = now + 30
  await catalog(await normal())
  const cached = _internal.routes.get(state.key + "\0" + state.jwt)
  expect(cached.ttl).toBeGreaterThan(0)
  expect(cached.ttl).toBeLessThanOrEqual(30000)
  expect(cached.gift.allModels).toEqual([])
})

test("ambiguous balances cannot borrow the start time of an older grant of the same plan", async () => {
  const future = balance.plans[0]
  balance.plans.unshift({
    ...future, user_plan_id: "older-grant", name: "Older grant",
    entitlements: [{ ...future.entitlements[0], effective_at: now - 3600 }],
  })
  const ambiguous = bucket()
  delete ambiguous.user_plan_id
  balance.balances.push(ambiguous)
  const h = await start()
  expect(await catalog(h)).toEqual({})
  const card = await usage(h)
  expect(card.windows).toHaveLength(1)
  expect(card.windows[0].aside).toBe(true)
  expect(card.windows[0].name).toContain("待生效")
  expect(card.windows[0].models).toBeUndefined()
})

test("an exact grant identity still selects its pending entitlement beside an older grant", async () => {
  const future = balance.plans[0]
  balance.plans.unshift({
    ...future, user_plan_id: "older-grant",
    entitlements: [{ ...future.entitlements[0], effective_at: now - 3600 }],
  })
  balance.balances.push(bucket())
  const h = await start()
  expect(await catalog(h)).toEqual({})
  expect((await usage(h)).windows[0].aside).toBe(true)
})

test("expired or unusable balances do not hide a granted future entitlement", async () => {
  for (const expires_at of [now - 60, now + 1800]) {
    balance.balances = [{ ...bucket(), expires_at }]
    const h = await start()
    expect(await catalog(h)).toEqual({})
    const card = await usage(h)
    expect(card.windows).toHaveLength(1)
    expect(card.windows[0]).toMatchObject({ aside: true })
    expect(card.windows[0].display).toContain("500000000 tokens")
  }
})
