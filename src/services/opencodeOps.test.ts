import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { makeOpenCodeOps } from "./opencode.js"

function mockClient(handlers: {
  create?: () => Promise<{ error?: unknown; data?: { id?: string } }>
  promptAsync?: (args: unknown) => Promise<{ error?: unknown }>
  messages?: () => Promise<{ error?: unknown; data?: unknown[] }>
  abort?: () => Promise<unknown>
  health?: () => Promise<{ error?: unknown; data?: { version?: string } }>
}): OpencodeClient {
  return {
    session: {
      create: handlers.create ?? (async () => ({ data: { id: "ses_1" } })),
      promptAsync: handlers.promptAsync ?? (async () => ({})),
      messages: handlers.messages ?? (async () => ({ data: [] })),
      abort: handlers.abort ?? (async () => ({})),
    },
    global: {
      health: handlers.health ?? (async () => ({ data: { version: "1.0.0" } })),
    },
  } as unknown as OpencodeClient
}

const config = { opencodeModel: "custom/default", opencodeAgent: "hanhua-search" }

test("createSession returns the session id", async () => {
  const ops = makeOpenCodeOps({ client: mockClient({}), config })
  const id = await Effect.runPromise(ops.createSession)
  assert.equal(id, "ses_1")
})

test("createSession fails when the SDK returns an error", async () => {
  const ops = makeOpenCodeOps({
    client: mockClient({
      create: async () => ({ error: { message: "busy" } }),
    }),
    config,
  })
  await assert.rejects(
    () => Effect.runPromise(ops.createSession),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /创建 opencode 会话失败/)
      return true
    },
  )
})

test("submitSearch sends agent, split model, and the query in the user message", async () => {
  let captured: unknown
  const ops = makeOpenCodeOps({
    client: mockClient({
      promptAsync: async (args) => {
        captured = args
        return {}
      },
    }),
    config,
  })
  await Effect.runPromise(
    ops.submitSearch("ses_1", { query: "某漫画", type: "manga", stream: false }),
  )
  const rec = captured as {
    sessionID: string
    agent: string
    model?: { providerID: string; modelID: string }
    parts: Array<{ type: string; text: string }>
  }
  assert.equal(rec.sessionID, "ses_1")
  assert.equal(rec.agent, "hanhua-search")
  assert.deepEqual(rec.model, { providerID: "custom", modelID: "default" })
  assert.match(rec.parts[0]!.text, /某漫画/)
  assert.match(rec.parts[0]!.text, /漫画/)
})

test("health is ok:false when the SDK reports an error", async () => {
  const ops = makeOpenCodeOps({
    client: mockClient({
      health: async () => ({ error: { message: "down" } }),
    }),
    config,
  })
  const health = await Effect.runPromise(ops.health)
  assert.deepEqual(health, { ok: false })
})
