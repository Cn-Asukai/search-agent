import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Fiber, Option, PubSub, type Scope } from "effect"
import type { OpencodeEvent } from "./eventBridge.js"
import { waitSessionSettled } from "./sessionWait.js"

const sessionID = "ses_1"

function assistantEvent(
  id: string,
  extra: Record<string, unknown> = {},
): OpencodeEvent {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id,
        sessionID,
        role: "assistant",
        ...extra,
      },
    },
  }
}

function idleEvent(id = sessionID): OpencodeEvent {
  return { type: "session.idle", properties: { sessionID: id } }
}

function run<A>(effect: Effect.Effect<A, never, Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect))
}

test("does not settle on the first assistant message", async () => {
  await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      const fiber = yield* waitSessionSettled(events, sessionID, Duration.millis(1500)).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(30))
      yield* PubSub.publish(events, assistantEvent("msg_1"))
      yield* PubSub.publish(events, idleEvent())
      const early = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(Duration.millis(80)))
      assert.equal(early._tag, "None", "must ignore idle until assistant time.completed")
      yield* PubSub.publish(
        events,
        assistantEvent("msg_1", { time: { created: 1, completed: 2 }, finish: "stop" }),
      )
      yield* PubSub.publish(events, idleEvent())
      const result = yield* Fiber.join(fiber)
      assert.equal(result.ok, true)
      assert.equal(result.finalInfo && "id" in result.finalInfo ? result.finalInfo.id : undefined, "msg_1")
    }),
  )
})

test("keeps the latest assistant after tools, then settles on idle", async () => {
  await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      const fiber = yield* waitSessionSettled(events, sessionID, Duration.millis(1500)).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(30))
      yield* PubSub.publish(events, assistantEvent("msg_1"))
      yield* PubSub.publish(
        events,
        assistantEvent("msg_2", {
          time: { created: 1, completed: 2 },
          finish: "stop",
          structured: {
            verdict: "uncertain",
            confidence: "low",
            work: { original_title: "aaa", type: "other" },
            official: { exists: false },
            fan: { exists: false, translations: [] },
            sources: [],
            summary: "无法确认",
          },
        }),
      )
      yield* PubSub.publish(events, idleEvent())
      const result = yield* Fiber.join(fiber)
      assert.equal(result.ok, true)
      assert.equal(result.finalInfo && "id" in result.finalInfo ? result.finalInfo.id : undefined, "msg_2")
      assert.ok(result.finalInfo && "structured" in result.finalInfo && result.finalInfo.structured)
    }),
  )
})

test("settles on assistant error without waiting for idle", async () => {
  await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      const fiber = yield* waitSessionSettled(events, sessionID, Duration.millis(1500)).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(30))
      yield* PubSub.publish(
        events,
        assistantEvent("msg_err", {
          error: { name: "StructuredOutputError", message: "Model did not produce structured output" },
        }),
      )
      const result = yield* Fiber.join(fiber)
      assert.equal(result.ok, false)
      assert.ok(!result.ok)
      assert.match(result.error, /结构化输出失败/)
    }),
  )
})

test("captures StructuredOutput tool input as fallback payload", async () => {
  await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      const fiber = yield* waitSessionSettled(events, sessionID, Duration.millis(1500)).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(30))
      yield* PubSub.publish(events, assistantEvent("msg_1", { time: { created: 1, completed: 2 }, finish: "stop" }))
      yield* PubSub.publish(events, {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            type: "tool",
            tool: "StructuredOutput",
            state: {
              status: "completed",
              input: { verdict: "none", summary: "from-tool" },
            },
          },
        },
      })
      yield* PubSub.publish(events, idleEvent())
      const result = yield* Fiber.join(fiber)
      assert.equal(result.ok, true)
      assert.deepEqual(result.structuredFromTool, { verdict: "none", summary: "from-tool" })
    }),
  )
})

test("ignores idle from another session", async () => {
  await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      const fiber = yield* waitSessionSettled(events, sessionID, Duration.millis(1500)).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(30))
      yield* PubSub.publish(events, assistantEvent("msg_1", { time: { created: 1, completed: 2 }, finish: "stop" }))
      yield* PubSub.publish(events, idleEvent("ses_other"))
      const early = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(Duration.millis(80)))
      assert.equal(Option.isNone(early), true)
      yield* PubSub.publish(events, idleEvent())
      const result = yield* Fiber.join(fiber)
      assert.equal(result.ok, true)
    }),
  )
})
