// A Coding Plan limit refusal (1308 five hours, 1310 weekly) is rewritten
// so magpie reads it as out of quota instead of a rate limit: without it
// the account rests whole and its Start Plan (-Trial) models rest with it
// (magpie#3661 rest-scope thread). The envelope, the code and the reset
// time are kept; anything else goes as it came.
import { afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

async function send(reply) {
  globalThis.fetch = async () => reply()
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "one.secret", metadata: { site: "zai" } }), { id: "zcode" })
  return opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", body: "{}" })
}

test("a 1308 refusal names the usage limit and keeps the reset time", async () => {
  const body = { type: "error", error: { type: "rate_limit_error", code: "1308", message: "已达到 5 小时的使用上限。您的限额将在 2026-10-27 03:27:52 重置。" } }
  const res = await send(() => Response.json(body, { status: 429 }))
  expect(res.status).toBe(429)
  const got = await res.json()
  expect(got.error.type).toBe("usage_limit_error")
  expect(got.error.code).toBe("1308")
  expect(got.error.message).toContain("Usage limit reached")
  expect(got.error.message).toContain("Your limit will reset at 2026-10-27 03:27:52")
  expect(got.error.message).not.toContain("rate limit")
})

test("a 1310 weekly refusal is rewritten the same way", () => {
  const body = JSON.stringify({ error: { code: "1310", message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-02 00:00:00" } })
  const res = _internal.limitAnswer(new Response(body, { status: 429 }), body)
  expect(res).not.toBeNull()
})

test("other 429s go as they came", async () => {
  const body = { error: { code: "1302", message: "rate limit reached" } }
  const res = await send(() => Response.json(body, { status: 429 }))
  expect(res.status).toBe(429)
  expect(await res.json()).toEqual(body)
})

test("a 1308 body with no readable time still says the usage limit", () => {
  const body = JSON.stringify({ error: { code: "1308", message: "已达到 5 小时的使用上限。" } })
  const res = _internal.limitAnswer(new Response(body, { status: 429 }), body)
  expect(res).not.toBeNull()
})
