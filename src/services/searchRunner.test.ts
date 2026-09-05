import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Fiber, Option, PubSub, Stream, type Scope } from "effect"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { OpencodeEvent } from "./eventBridge.js"
import { makeSearchRunner } from "./searchRunner.js"
import { makeTaskManager, type TaskManagerService } from "./taskManager.js"
import type { OpenCodeOpsService } from "./opencode.js"
import type { SearchResult } from "../domain/search.js"

const validResult: SearchResult = {
  verdict: "uncertain",
  confidence: "low",
  work: { original_title: "aaa", type: "other" },
  official: { exists: false },
  fan: { exists: false, translations: [] },
  sources: [],
  summary: "无法确认该作品",
}

function run<A>(effect: Effect.Effect<A, never, Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect))
}

function waitTerminal(tasks: TaskManagerService, taskId: string) {
  return Stream.fromPubSub(tasks.events).pipe(
    Stream.filter((ev) => ev.task.id === taskId && (ev._tag === "done" || ev._tag === "error")),
    Stream.take(1),
    Stream.runHead,
  )
}

function fakeOps(overrides: Partial<OpenCodeOpsService> = {}): OpenCodeOpsService {
  return {
    createSession: Effect.succeed("ses_1"),
    submitSearch: () => Effect.void,
    getLatestAssistant: () => Effect.fail(new Error("未找到模型回复")),
    abortSession: () => Effect.void,
    health: Effect.succeed({ ok: true }),
    ...overrides,
  }
}

test("createSession failure marks the task error and releases the concurrency slot", async () => {
  await run(
    Effect.gen(function* () {
      const tasks = yield* makeTaskManager({ maxConcurrency: 1 })
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      let creates = 0
      const runner = makeSearchRunner({
        ops: fakeOps({
          createSession: Effect.sync(() => {
            creates += 1
          }).pipe(Effect.flatMap(() => Effect.fail(new Error("opencode 挂了")))),
        }),
        tasks,
        bridge: { events },
        config: { taskTimeout: Duration.millis(1_000) },
      })

      const first = yield* tasks.create("一", "novel")
      const second = yield* tasks.create("二", "novel")
      const w1 = yield* waitTerminal(tasks, first.id).pipe(Effect.forkScoped)
      const w2 = yield* waitTerminal(tasks, second.id).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(20))

      yield* runner.launch(first.id)
      yield* runner.launch(second.id)

      const e1 = Option.getOrThrow(yield* Fiber.join(w1))
      const e2 = Option.getOrThrow(yield* Fiber.join(w2))
      assert.equal(e1._tag, "error")
      assert.equal(e2._tag, "error")
      assert.match(e1.task.error ?? "", /opencode 挂了/)
      assert.match(e2.task.error ?? "", /opencode 挂了/)
      assert.equal(creates, 2)
    }),
  )
})

test("structured result from the event stream marks the task done", async () => {
  await run(
    Effect.gen(function* () {
      const tasks = yield* makeTaskManager({ maxConcurrency: 1 })
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      const sessionID = "ses_1"
      const runner = makeSearchRunner({
        ops: fakeOps({
          submitSearch: () =>
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(30))
              yield* PubSub.publish(events, {
                type: "message.updated",
                properties: {
                  sessionID,
                  info: {
                    id: "msg_1",
                    sessionID,
                    role: "assistant",
                    structured: validResult,
                  } as AssistantMessage,
                },
              })
              yield* PubSub.publish(events, {
                type: "session.idle",
                properties: { sessionID },
              })
            }),
          getLatestAssistant: () => Effect.die("should not pull messages when structured is in the event"),
        }),
        tasks,
        bridge: { events },
        config: { taskTimeout: Duration.millis(1_500) },
      })

      const task = yield* tasks.create("某小说", "novel")
      const waiter = yield* waitTerminal(tasks, task.id).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(20))
      yield* runner.launch(task.id)

      const event = Option.getOrThrow(yield* Fiber.join(waiter))
      assert.equal(event._tag, "done")
      assert.equal(event.task.status, "done")
      assert.equal(event.task.result?.work.original_title, "aaa")
      assert.equal(event.task.sessionId, sessionID)
    }),
  )
})

test("timeout without a structured result marks the task error", async () => {
  await run(
    Effect.gen(function* () {
      const tasks = yield* makeTaskManager({ maxConcurrency: 1 })
      const events = yield* PubSub.unbounded<OpencodeEvent>()
      let aborted = false
      const runner = makeSearchRunner({
        ops: fakeOps({
          abortSession: () =>
            Effect.sync(() => {
              aborted = true
            }),
        }),
        tasks,
        bridge: { events },
        config: { taskTimeout: Duration.millis(50) },
      })

      const task = yield* tasks.create("超时作品", "unknown")
      const waiter = yield* waitTerminal(tasks, task.id).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(20))
      yield* runner.launch(task.id)

      const event = Option.getOrThrow(yield* Fiber.join(waiter))
      assert.equal(event._tag, "error")
      assert.match(event.task.error ?? "", /检索超时/)
      assert.equal(aborted, true)
    }),
  )
})
