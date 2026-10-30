// Exercise the separate zcode-start provider without Magpie or the vendor.
// Run with HOME=$(mktemp -d) bun test.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, ZCodeStartAuthPlugin, _internal
const realFetch = globalThis.fetch
const MESSAGE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
const START_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1"

beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((p) => homedir().startsWith(p))) {
    throw new Error("run with an isolated HOME under the temporary directory")
  }
  ;({ ZCodeAuthPlugin, ZCodeStartAuthPlugin, _internal } = await import("./index.mjs"))
})

beforeEach(() => {
  _internal.routes.clear()
  _internal.blocked.clear()
  _internal.config(null)
  globalThis.fetch = async () => {
    throw new Error("unexpected network request")
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  _internal.routes.clear()
  _internal.blocked.clear()
  _internal.config(undefined)
})

function jwt(seed) {
  return ["{}", JSON.stringify({ sub: seed, exp: Math.floor(Date.now() / 1000) + 3600 })]
    .map((part) => Buffer.from(part).toString("base64url")).join(".") + ".sig"
}

function signIn(uid, token = "one") {
  const access = jwt(`${uid}-${token}`)
  const state = { site: "zai", jwt: access, device: `device-${uid}` }
  return {
    type: "oauth",
    access,
    refresh: JSON.stringify(state),
    expires: 0,
    accountId: `${uid}@example.test`,
    uid,
  }
}

function codingSignIn(uid) {
  const auth = signIn(uid)
  const state = JSON.parse(auth.refresh)
  state.key = `${uid}.secret`
  state.plan = "GLM Coding Pro"
  auth.access = state.key
  auth.refresh = JSON.stringify(state)
  return auth
}

function balance(models = ["glm-5.3", "glm-5.3-flash"]) {
  const now = Math.floor(Date.now() / 1000)
  return {
    plans: [{
      plan_id: "zai-start-plan",
      user_plan_id: "start-1",
      name: "ZCode Start Plan",
      status: "active",
      ends_at: now + 7 * 86400,
    }],
    balances: models.map((model) => ({
      plan_id: "zai-start-plan",
      user_plan_id: "start-1",
      show_name: model,
      capabilities: [`model:${model}`],
      total_units: 100,
      used_units: 10,
      remaining_units: 90,
    })),
  }
}

function serveBalance(value) {
  const calls = []
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(url)
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") {
      return Response.json({ code: 0, data: value })
    }
    throw new Error(`unexpected request: ${url}`)
  }
  return calls
}

const message = (model) => JSON.stringify({
  model,
  max_tokens: 16,
  messages: [{ role: "user", content: "offline test" }],
})

test("the package exports a Start-only provider without adding another option", async () => {
  const normal = await ZCodeAuthPlugin({ client: {}, magpie: {} })
  const start = await ZCodeStartAuthPlugin({ client: {}, magpie: {} })
  expect(normal.provider.id).toBe("zcode")
  expect(start.provider.id).toBe("zcode-start")
  expect(normal.auth.provider).toBe("zcode")
  expect(start.auth.provider).toBe("zcode-start")
  expect(normal.auth.maxConcurrency).toBe(_internal.DEFAULT_CONCURRENCY)
  expect(start.auth.maxConcurrency).toBe(_internal.DEFAULT_CONCURRENCY)
  expect(normal.auth.icon).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
  expect(start.auth.icon).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
  expect(start.auth.icon).not.toBe(normal.auth.icon)
  expect(start.auth.noStaticModels).toBe(true)
  expect(start.auth.options).toBeUndefined()
  expect(normal.auth.options).toBeUndefined()
  const cfg = { provider: {} }
  await start.config(cfg)
  expect(cfg.provider["zcode-start"].name).toBe("ZCode Start Plan")
  expect(cfg.provider["zcode-start"].models).toBeUndefined()
  expect(typeof normal.config).toBe("function")
  expect(start.auth.methods).toHaveLength(1)
  expect(() => start.auth.methods[0].authorize()).toThrow("reuses ZCode's sign-ins")
})

test("normal ZCode reads mirror stable OAuth identities under zcode-start", async () => {
  serveBalance(balance())
  const writes = []
  const hooks = await ZCodeAuthPlugin({
    client: { auth: { set: async (value) => writes.push(value) } },
    magpie: {},
  })
  const first = signIn("same", "one")
  const rotated = signIn("same", "two")
  const other = signIn("other")
  for (const auth of [first, rotated, other]) {
    await hooks.provider.models({ models: {} }, { auth })
  }
  expect(writes).toHaveLength(3)
  const ids = writes.map((write) => write.path.id)
  expect(ids.every((id) => /^zcode-start#[0-9a-f]{12}$/.test(id))).toBe(true)
  expect(ids[0]).toBe(ids[1])
  expect(ids[0]).not.toBe(ids[2])
  expect(writes.map((write) => write.body)).toEqual([first, rotated, other])
})

test("zcode-start lists only live Trial aliases, and nothing without a gift", async () => {
  const start = await ZCodeStartAuthPlugin({ client: {}, magpie: {} })
  const normal = await ZCodeAuthPlugin({ client: {}, magpie: {} })
  const auth = signIn("catalog")
  serveBalance(balance())
  const only = await start.provider.models({ models: {} }, { auth })
  expect(Object.keys(only).sort()).toEqual(["GLM-5.3-Flash-Trial", "GLM-5.3-Trial"])
  expect(Object.keys(only).every((id) => id.endsWith("-Trial"))).toBe(true)
  expect(only[Symbol.for("magpie.fellBack")]).toBeUndefined()
  for (const model of Object.values(only)) {
    expect(model.providerID).toBe("zcode-start")
    expect(model.api.url).toBe(START_URL)
  }

  const all = await normal.provider.models({ models: {} }, { auth })
  expect(all["GLM-5.3"]).toBeDefined()
  expect(all["GLM-5.3-Flash"]).toBeDefined()
  expect(all["GLM-5.3-Trial"]).toBeDefined()
  expect(all["GLM-5.3-Flash-Trial"]).toBeDefined()

  const partlySpent = balance()
  partlySpent.balances[1].used_units = 100
  partlySpent.balances[1].remaining_units = 0
  serveBalance(partlySpent)
  expect(Object.keys(await start.provider.models({ models: {} }, { auth }))).toEqual(["GLM-5.3-Trial"])

  serveBalance({ plans: [], balances: [] })
  expect(await start.provider.models({ models: {} }, { auth })).toEqual({})
})

test("the Start card carries gift windows only", async () => {
  const start = await ZCodeStartAuthPlugin({ client: {}, magpie: {} })
  serveBalance(balance())
  const card = await start.auth.usage(async () => signIn("usage"))
  expect(card.plan).toBe("ZCode Start Plan")
  expect(card.signIn).toBe("kept")
  expect(card.windows).toHaveLength(2)
  expect(card.windows.every((window) => !window.name.includes("5 hours"))).toBe(true)
  expect(card.windows[0].models).toContain("GLM-5.3-Trial")
  expect(card.windows[1].models).toContain("GLM-5.3-Flash-Trial")
})

test("a Pro account's Start lane reads the gift balance without its coding plan", async () => {
  const hooks = await ZCodeStartAuthPlugin({ client: {}, magpie: {} })
  const pro = codingSignIn("pro")
  _internal.config(undefined)
  const calls = serveBalance(balance())
  expect(Object.keys(await hooks.provider.models({ models: {} }, { auth: pro }))).toContain("GLM-5.3-Trial")
  expect((await hooks.auth.usage(async () => pro)).plan).toBe("ZCode Start Plan")
  expect(calls.map((url) => url.pathname)).toEqual([
    "/api/v1/zcode-plan/billing/balance",
    "/api/v1/zcode-plan/billing/balance",
  ])
})

test("a non-Trial request is refused before any vendor call", async () => {
  const hooks = await ZCodeStartAuthPlugin({ client: {}, magpie: {} })
  const loader = await hooks.auth.loader(async () => signIn("direct"), { id: "zcode-start" })
  let sent = 0
  globalThis.fetch = async () => {
    sent++
    return Response.json({ type: "message", content: [] })
  }
  const response = await loader.fetch(MESSAGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: message("GLM-5.3"),
  })
  expect(response.status).toBe(400)
  expect(sent).toBe(0)
  expect((await response.json()).error.message).toContain("only Start Plan -Trial models")
})

test("a Trial request maps its alias and uses Magpie's native queue declaration", async () => {
  const hooks = await ZCodeStartAuthPlugin({ client: {}, magpie: {} })
  expect(hooks.auth.maxConcurrency).toBe(_internal.DEFAULT_CONCURRENCY)
  const auth = codingSignIn("queued")
  const loader = await hooks.auth.loader(async () => auth, { id: "zcode-start" })
  const gift = balance(["glm-5.3-flash"])
  let balanceRead = false
  const sent = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") {
      balanceRead = true
      return Response.json({ code: 0, data: gift })
    }
    if (url.pathname === "/api/v1/zcode-plan/anthropic/v1/messages") {
      sent.push({ url, headers: new Headers(init.headers), body: init.body })
      return Response.json({ type: "message", content: [] })
    }
    throw new Error(`unexpected request: ${url}`)
  }
  const response = await loader.fetch(MESSAGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: message("GLM-5.3-Flash-Trial"),
  })
  expect(response.status).toBe(200)
  expect(balanceRead).toBe(true)
  expect(sent).toHaveLength(1)
  expect(sent[0].url.href).toBe(MESSAGE_URL)
  const startToken = JSON.parse(auth.refresh).jwt
  expect(sent[0].headers.get("authorization")).toBe("Bearer " + startToken)
  expect(JSON.parse(sent[0].body).model).toBe("glm-5.3-flash")
})
