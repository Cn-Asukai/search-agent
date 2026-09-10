import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, PubSub } from "effect"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { describePartEvent, eventLoop, type OpencodeEvent } from "./eventBridge.js"

test("eventLoop opens one SSE subscription instead of a tight forever respawn", async () => {
  let subscribeCalls = 0
  const client = {
    event: {
      subscribe: async () => {
        subscribeCalls += 1
        return {
          stream: (async function* () {
            // 立刻结束,让 native loop 进入 5s 退避;旧实现会在 80ms 内狂开订阅
          })(),
        }
      },
    },
  } as unknown as OpencodeClient

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OpencodeEvent>()
        yield* eventLoop(client, events).pipe(Effect.forkScoped)
        yield* Effect.sleep(Duration.millis(80))
      }),
    ),
  )

  assert.equal(subscribeCalls, 1, `expected 1 subscribe, got ${subscribeCalls}`)
})

function partEvent(
  tool: string,
  status: "running" | "completed" | "error",
  input?: Record<string, unknown>,
): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool,
        state: { status, input },
      },
    },
  }
}

test("describePartEvent translates smartsearch running and completed to Chinese", () => {
  const running = describePartEvent(
    partEvent("websearch_smartsearch", "running", { query: "転生したら剣でした 汉化" }),
  )
  assert.ok(running)
  assert.equal(running.state, "running")
  assert.equal(running.tool, "websearch_smartsearch")
  assert.match(running.message, /正在联网搜索/)
  assert.match(running.message, /転生したら剣でした/)

  const completed = describePartEvent(
    partEvent("websearch_smartsearch", "completed", { query: "転生したら剣でした 汉化" }),
  )
  assert.ok(completed)
  assert.equal(completed.state, "completed")
  assert.match(completed.message, /联网搜索完成/)
  assert.match(completed.message, /転生したら剣でした/)
})

test("describePartEvent does not leak structuredoutput input", () => {
  const entry = describePartEvent(
    partEvent("StructuredOutput", "completed", { verdict: "none", summary: "SECRET_PAYLOAD" }),
  )
  assert.ok(entry)
  assert.equal(entry.detail, undefined)
  assert.equal(entry.message.includes("SECRET_PAYLOAD"), false)
  assert.equal(entry.message.includes("verdict"), false)
  assert.match(entry.message, /结构化结论/)
})
