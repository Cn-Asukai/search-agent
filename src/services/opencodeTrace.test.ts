import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Layer, Option, PubSub, type Scope } from "effect"
import { AppConfig } from "../env.js"
import { SqliteLive } from "./sqlite.js"
import { persistOpencodeTrace, TaskManager, TaskManagerLive } from "./taskManager.js"
import type { OpencodeEvent } from "./eventBridge.js"

function configLive(sqlitePath: string) {
  return Layer.succeed(
    AppConfig,
    AppConfig.of({
      port: 8787,
      host: "127.0.0.1",
      opencodeHostname: "127.0.0.1",
      opencodePort: 0,
      opencodeModel: undefined,
      opencodeAgent: "hanhua-search",
      taskTimeout: Duration.millis(60_000),
      maxConcurrency: 2,
      syncMaxWait: Duration.millis(60_000),
      apiAuthKey: undefined,
      sqlitePath,
    }),
  )
}

function tasksLayer(sqlitePath: string) {
  return TaskManagerLive.pipe(Layer.provideMerge(SqliteLive), Layer.provide(configLive(sqlitePath)))
}

function run<A>(effect: Effect.Effect<A, never, TaskManager | Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(tasksLayer(":memory:")))))
}

test("sessionId initializes opencode_trace; call and event append in order", async () => {
  await run(Effect.gen(function* () {
    const tasks = yield* TaskManager
    const created = yield* tasks.create("query", "novel")
    yield* tasks.update(created.id, { sessionId: "ses_1" })

    const empty = Option.getOrThrow(yield* tasks.getTrace(created.id))
    assert.equal(empty.sessionId, "ses_1")
    assert.equal(empty.steps.length, 0)

    yield* tasks.appendTraceStep("ses_1", {
      kind: "call",
      ts: 10,
      method: "session.create",
      durationMs: 5,
      response: { id: "ses_1" },
    })
    yield* tasks.appendTraceStep("ses_1", {
      kind: "event",
      ts: 20,
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: { type: "tool", tool: "smartsearch" } },
    })

    const trace = Option.getOrThrow(yield* tasks.getTrace(created.id))
    assert.equal(trace.steps.length, 2)
    assert.equal(trace.steps[0]?.kind, "call")
    assert.equal(trace.steps[1]?.kind, "event")
    if (trace.steps[0]?.kind === "call") {
      assert.equal(trace.steps[0].method, "session.create")
    }
    if (trace.steps[1]?.kind === "event") {
      assert.equal(trace.steps[1].type, "message.part.updated")
    }

    const task = Option.getOrThrow(yield* tasks.get(created.id))
    assert.equal("opencode_trace" in task, false)
  }))
})

test("events without sessionID are not written; unknown session is a no-op", async () => {
  await run(Effect.gen(function* () {
    const tasks = yield* TaskManager
    const created = yield* tasks.create("query", "unknown")
    yield* tasks.update(created.id, { sessionId: "ses_keep" })

    const events = yield* PubSub.unbounded<OpencodeEvent>()
    yield* persistOpencodeTrace(events, tasks).pipe(Effect.forkScoped)
    yield* Effect.sleep(Duration.millis(20))

    yield* PubSub.publish(events, { type: "server.heartbeat", properties: {} })
    yield* PubSub.publish(events, {
      type: "message.updated",
      properties: { sessionID: "ses_other", info: { role: "assistant" } },
    })
    yield* PubSub.publish(events, {
      type: "message.updated",
      properties: { sessionID: "ses_keep", info: { role: "assistant" } },
    })

    let trace = Option.getOrThrow(yield* tasks.getTrace(created.id))
    for (let i = 0; i < 20 && trace.steps.length === 0; i++) {
      yield* Effect.sleep(Duration.millis(10))
      trace = Option.getOrThrow(yield* tasks.getTrace(created.id))
    }
    assert.equal(trace.steps.length, 1)
    assert.equal(trace.steps[0]?.kind, "event")
    if (trace.steps[0]?.kind === "event") {
      assert.equal(trace.steps[0].type, "message.updated")
    }
  }))
})

test("getTrace is none when task has no session", async () => {
  await run(Effect.gen(function* () {
    const tasks = yield* TaskManager
    const created = yield* tasks.create("query", "manga")
    const trace = yield* tasks.getTrace(created.id)
    assert.equal(Option.isNone(trace), true)
  }))
})
