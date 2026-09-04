import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, PubSub } from "effect"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { eventLoop, type OpencodeEvent } from "./eventBridge.js"

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
