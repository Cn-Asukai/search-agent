import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Fiber, Option, Stream, type Scope } from "effect"
import { makeTaskManager } from "./taskManager.js"

function run<A>(effect: Effect.Effect<A, never, Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect))
}

test("create records query and injected id/clock", async () => {
  await run(
    Effect.gen(function* () {
      const tasks = yield* makeTaskManager({
        maxConcurrency: 2,
        now: () => 1_000,
        newId: () => "task-1",
      })
      const created = yield* tasks.create("某小说", "novel")
      assert.equal(created.id, "task-1")
      assert.equal(created.query, "某小说")
      assert.equal(created.type, "novel")
      assert.equal(created.status, "queued")
      assert.equal(created.createdAt, 1_000)
      assert.equal(created.updatedAt, 1_000)

      const got = yield* tasks.get("task-1")
      assert.equal(Option.getOrThrow(got).id, "task-1")
      assert.equal(Option.isNone(yield* tasks.get("missing")), true)

      const stats = yield* tasks.stats
      assert.deepEqual(stats, { total: 1, queued: 1, running: 0 })
    }),
  )
})

test("appendProgress assigns seq/ts from the injected clock and emits", async () => {
  await run(
    Effect.gen(function* () {
      let ts = 5_000
      const tasks = yield* makeTaskManager({
        maxConcurrency: 1,
        now: () => ts,
        newId: () => "task-1",
      })
      yield* tasks.create("q", "manga")

      const fiber = yield* Stream.fromPubSub(tasks.events).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.forkScoped,
      )
      yield* Effect.sleep(Duration.millis(20))
      ts = 5_100
      yield* tasks.appendProgress("task-1", { kind: "status", message: "开始" })

      const event = Option.getOrThrow(yield* Fiber.join(fiber))
      assert.equal(event._tag, "progress")
      if (event._tag !== "progress") return
      assert.equal(event.entry.seq, 1)
      assert.equal(event.entry.ts, 5_100)
      assert.equal(event.entry.message, "开始")

      const task = Option.getOrThrow(yield* tasks.get("task-1"))
      assert.equal(task.progress.length, 1)
      assert.equal(task.updatedAt, 5_100)
    }),
  )
})

test("update to done/error emits the corresponding task event", async () => {
  await run(
    Effect.gen(function* () {
      const tasks = yield* makeTaskManager({
        maxConcurrency: 1,
        now: () => 1,
        newId: () => "task-1",
      })
      yield* tasks.create("q", "unknown")

      const fiber = yield* Stream.fromPubSub(tasks.events).pipe(
        Stream.filter((ev) => ev._tag === "error"),
        Stream.take(1),
        Stream.runHead,
        Effect.forkScoped,
      )
      yield* Effect.sleep(Duration.millis(20))
      yield* tasks.update("task-1", { status: "error", error: "boom" })

      const event = Option.getOrThrow(yield* Fiber.join(fiber))
      assert.equal(event._tag, "error")
      assert.equal(event.task.status, "error")
      assert.equal(event.task.error, "boom")
    }),
  )
})
