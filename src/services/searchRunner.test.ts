import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Layer, Option, PubSub, type Context } from "effect"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { AppConfig } from "../env.js"
import type { SearchResult, Task } from "../domain/search.js"
import type { OpencodeEvent } from "./eventBridge.js"
import { EventBridge, EventBridgeLive } from "./eventBridge.js"
import { OpenCode, OpenCodeOps } from "./opencode.js"
import { SqliteLive } from "./sqlite.js"
import { TaskManager, TaskManagerLive } from "./taskManager.js"
import { SearchRunner, SearchRunnerLive } from "./searchRunner.js"

type Ops = Context.Service.Shape<typeof OpenCodeOps>

const sampleResult: SearchResult = {
  verdict: "official",
  confidence: "high",
  work: { original_title: "転生したら剣でした", type: "novel" },
  official: { exists: true, publisher: "东立出版社" },
  fan: { exists: false, translations: [] },
  sources: [{ url: "https://example.test/official", kind: "official" }],
  summary: "存在官方中文",
}

function configLive(taskTimeoutMs: number) {
  return Layer.succeed(
    AppConfig,
    AppConfig.of({
      port: 8787,
      host: "127.0.0.1",
      opencodeHostname: "127.0.0.1",
      opencodePort: 0,
      opencodeModel: undefined,
      opencodeAgent: "hanhua-search",
      taskTimeout: Duration.millis(taskTimeoutMs),
      maxConcurrency: 2,
      syncMaxWait: Duration.millis(1_000),
      apiAuthKey: undefined,
      sqlitePath: ":memory:",
    }),
  )
}

const OpenCodeTest = Layer.succeed(
  OpenCode,
  OpenCode.of({
    client: {} as OpencodeClient,
    url: "http://127.0.0.1:9",
    close: () => undefined,
  }),
)

function opsLayer(overrides: Partial<Ops> = {}) {
  const base: Ops = {
    createSession: Effect.succeed("ses_test"),
    submitSearch: () => Effect.void,
    getLatestAssistant: () => Effect.fail(new Error("未找到模型回复")),
    abortSession: () => Effect.void,
    health: Effect.succeed({ ok: true, version: "test" }),
  }
  return Layer.succeed(OpenCodeOps, OpenCodeOps.of({ ...base, ...overrides }))
}

function runnerLayer(
  taskTimeoutMs: number,
  ops: Layer.Layer<OpenCodeOps> = opsLayer(),
) {
  const config = configLive(taskTimeoutMs)
  const tasks = TaskManagerLive.pipe(Layer.provideMerge(SqliteLive), Layer.provide(config))
  return SearchRunnerLive.pipe(
    Layer.provideMerge(ops),
    Layer.provideMerge(OpenCodeTest),
    Layer.provideMerge(EventBridgeLive),
    Layer.provideMerge(tasks),
    Layer.provide(config),
  )
}

function run<A>(
  taskTimeoutMs: number,
  effect: Effect.Effect<A, unknown, SearchRunner | TaskManager | EventBridge>,
  ops?: Layer.Layer<OpenCodeOps>,
): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runnerLayer(taskTimeoutMs, ops)))))
}

function pollTask(
  id: string,
  predicate: (task: Task) => boolean,
  timeoutMs = 2_000,
): Effect.Effect<Task, Error, TaskManager> {
  return Effect.gen(function* () {
    const tasks = yield* TaskManager
    const deadline = Date.now() + timeoutMs
    while (true) {
      const opt = yield* tasks.get(id)
      if (Option.isSome(opt) && predicate(opt.value)) return opt.value
      if (Date.now() > deadline) {
        const last = Option.getOrNull(opt)
        return yield* Effect.fail(
          new Error(`timeout waiting for task ${id}: status=${last?.status} error=${last?.error}`),
        )
      }
      yield* Effect.sleep(Duration.millis(20))
    }
  })
}

function assistantDone(sessionID: string, extra: Record<string, unknown> = {}): OpencodeEvent {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id: "msg_1",
        sessionID,
        role: "assistant",
        time: { created: 1, completed: 2 },
        finish: "stop",
        ...extra,
      },
    },
  }
}

test("SearchRunner writes done when injected ops settle with a structured result", async () => {
  await run(2_000, Effect.gen(function* () {
    const runner = yield* SearchRunner
    const tasks = yield* TaskManager
    const bridge = yield* EventBridge
    const created = yield* tasks.create("転生したら剣でした", "novel")
    yield* runner.launch(created.id)
    yield* pollTask(created.id, (t) => t.status === "running" && Boolean(t.sessionId))
    yield* PubSub.publish(
      bridge.events,
      assistantDone("ses_test", { structured: sampleResult }),
    )
    const done = yield* pollTask(created.id, (t) => t.status === "done" || t.status === "error")
    assert.equal(done.status, "done")
    assert.equal(done.result?.verdict, "official")
    assert.equal(done.result?.official.exists, true)
    assert.equal(done.sessionId, "ses_test")
    assert.ok(done.endedAt)
  }))
})

test("SearchRunner writes error on task timeout and aborts the session", async () => {
  const aborted: string[] = []
  await run(
    80,
    Effect.gen(function* () {
      const runner = yield* SearchRunner
      const tasks = yield* TaskManager
      const created = yield* tasks.create("timeout-work", "manga")
      yield* runner.launch(created.id)
      const ended = yield* pollTask(created.id, (t) => t.status === "error", 2_000)
      assert.equal(ended.status, "error")
      assert.match(ended.error ?? "", /检索超时/)
      assert.deepEqual(aborted, ["ses_test"])
    }),
    opsLayer({
      abortSession: (sessionID) => Effect.sync(() => {
        aborted.push(sessionID)
      }),
    }),
  )
})

test("SearchRunner writes error when submitSearch fails", async () => {
  const aborted: string[] = []
  await run(
    2_000,
    Effect.gen(function* () {
      const runner = yield* SearchRunner
      const tasks = yield* TaskManager
      const bridge = yield* EventBridge
      const created = yield* tasks.create("submit-fail", "unknown")
      yield* runner.launch(created.id)
      const ended = yield* pollTask(created.id, (t) => t.status === "error")
      assert.equal(ended.status, "error")
      assert.equal(ended.error, "prompt 提交失败")
      assert.deepEqual(aborted, ["ses_test"])

      const progressAfterError = ended.progress.length
      yield* PubSub.publish(bridge.events, {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_test",
          part: {
            type: "tool",
            tool: "smartsearch",
            state: { status: "running", input: { query: "probe" } },
          },
        },
      })
      yield* Effect.sleep(Duration.millis(80))
      const after = Option.getOrThrow(yield* tasks.get(created.id))
      assert.equal(after.progress.length, progressAfterError)
    }),
    opsLayer({
      submitSearch: () => Effect.fail(new Error("prompt 提交失败")),
      abortSession: (sessionID) => Effect.sync(() => {
        aborted.push(sessionID)
      }),
    }),
  )
})

test("SearchRunner writes describeMessageError when the assistant ends with a model error", async () => {
  await run(2_000, Effect.gen(function* () {
    const runner = yield* SearchRunner
    const tasks = yield* TaskManager
    const bridge = yield* EventBridge
    const created = yield* tasks.create("auth-fail", "novel")
    yield* runner.launch(created.id)
    yield* pollTask(created.id, (t) => t.status === "running" && Boolean(t.sessionId))
    yield* PubSub.publish(
      bridge.events,
      assistantDone("ses_test", {
        error: { name: "ProviderAuthError", message: "no key" },
      }),
    )
    const ended = yield* pollTask(created.id, (t) => t.status === "error")
    assert.equal(ended.status, "error")
    assert.match(ended.error ?? "", /鉴权失败/)
  }))
})

test("abort RPC failure still marks the task error and releases the semaphore", async () => {
  const aborted: string[] = []
  await run(
    80,
    Effect.gen(function* () {
      const runner = yield* SearchRunner
      const tasks = yield* TaskManager
      const created = yield* tasks.create("abort-fail", "novel")
      yield* runner.launch(created.id)
      const ended = yield* pollTask(created.id, (t) => t.status === "error", 2_000)
      assert.equal(ended.status, "error")
      assert.match(ended.error ?? "", /检索超时/)
      assert.deepEqual(aborted, ["ses_test"])

      const first = yield* tasks.semaphore.takeIfAvailable(1)
      const second = yield* tasks.semaphore.takeIfAvailable(1)
      assert.equal(first, true)
      assert.equal(second, true)
      yield* tasks.semaphore.release(2)
    }),
    opsLayer({
      submitSearch: () => Effect.never,
      abortSession: (sessionID) => {
        aborted.push(sessionID)
        return Effect.fail(new Error("abort rpc failed"))
      },
    }),
  )
})
