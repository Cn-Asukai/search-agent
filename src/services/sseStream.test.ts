import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Fiber, Option, PubSub, Schedule, Stream, type Scope } from "effect"
import type { ProgressEntry, SseClientEvent, Task, TaskEvent } from "../domain/search.js"
import { buildSearchSseStream, encodeSse } from "./sseStream.js"

const taskId = "task-1"

function run<A>(effect: Effect.Effect<A, never, Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect))
}

function makeTask(status: Task["status"]): Task {
  return {
    id: taskId,
    query: "test",
    type: "unknown",
    status,
    createdAt: 1,
    updatedAt: 2,
    progress: [],
  }
}

const progressEntry: ProgressEntry = {
  seq: 1,
  ts: 1,
  kind: "status",
  message: "检索中",
}

function fastHeartbeat(): Stream.Stream<SseClientEvent> {
  return Stream.fromEffectSchedule(
    Effect.sync((): SseClientEvent => ({ event: "ping", data: { ts: Date.now() } })),
    Schedule.spaced("10 millis"),
  )
}

function collectUntilDone(
  events: PubSub.PubSub<TaskEvent>,
  getTask: (id: string) => Effect.Effect<Option.Option<Task>>,
  afterSubscribe: Effect.Effect<void>,
): Effect.Effect<readonly SseClientEvent[], never, Scope.Scope> {
  const stream = buildSearchSseStream({
    taskId,
    events,
    getTask,
    heartbeat: fastHeartbeat(),
  })
  return Effect.gen(function* () {
    const fiber = yield* Stream.runCollect(stream).pipe(Effect.forkScoped)
    yield* Effect.sleep(Duration.millis(20))
    yield* afterSubscribe
    return yield* Fiber.join(fiber).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(200),
        orElse: () => Effect.die("SSE stream did not complete after terminal event"),
      }),
    )
  })
}

test("progress then done emits task/progress/result and completes", async () => {
  const collected = await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<TaskEvent>()
      const running = makeTask("running")
      const done = makeTask("done")
      return yield* collectUntilDone(
        events,
        () => Effect.succeed(Option.some(running)),
        Effect.gen(function* () {
          yield* PubSub.publish(events, { _tag: "progress", task: running, entry: progressEntry })
          yield* PubSub.publish(events, { _tag: "done", task: done })
        }),
      )
    }),
  )

  const meaningful = collected.filter((ev) => ev.event !== "ping")
  assert.deepEqual(
    meaningful.map((ev) => ev.event),
    ["task", "progress", "result"],
  )
  assert.equal(collected.at(-1)?.event, "result")
})

test("error event completes the stream", async () => {
  const collected = await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<TaskEvent>()
      const running = makeTask("running")
      const failed = { ...makeTask("error"), error: "boom" }
      return yield* collectUntilDone(
        events,
        () => Effect.succeed(Option.some(running)),
        PubSub.publish(events, { _tag: "error", task: failed }),
      )
    }),
  )

  assert.equal(collected.at(-1)?.event, "error")
  assert.deepEqual(
    collected.filter((ev) => ev.event !== "ping").map((ev) => ev.event),
    ["task", "error"],
  )
})

test("already-done snapshot emits result and completes without live events", async () => {
  const collected = await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<TaskEvent>()
      const done = makeTask("done")
      return yield* collectUntilDone(
        events,
        () => Effect.succeed(Option.some(done)),
        Effect.void,
      )
    }),
  )

  assert.deepEqual(
    collected.filter((ev) => ev.event !== "ping").map((ev) => ev.event),
    ["task", "result"],
  )
  assert.equal(collected.at(-1)?.event, "result")
})

test("heartbeat is interrupted after done", async () => {
  const collected = await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<TaskEvent>()
      const running = makeTask("running")
      const done = makeTask("done")
      return yield* collectUntilDone(
        events,
        () => Effect.succeed(Option.some(running)),
        PubSub.publish(events, { _tag: "done", task: done }),
      )
    }),
  )

  assert.equal(collected.at(-1)?.event, "result")
  const pingsAfterResult = collected
    .slice(collected.findIndex((ev) => ev.event === "result") + 1)
    .filter((ev) => ev.event === "ping")
  assert.equal(pingsAfterResult.length, 0)
})

test("does not miss done published while snapshot still reads running", async () => {
  const collected = await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<TaskEvent>()
      const running = makeTask("running")
      const done = makeTask("done")
      const getTask = () =>
        Effect.gen(function* () {
          yield* PubSub.publish(events, { _tag: "done", task: done })
          return Option.some(running)
        })
      return yield* collectUntilDone(events, getTask, Effect.void)
    }),
  )

  const meaningful = collected.filter((ev) => ev.event !== "ping")
  assert.equal(meaningful.at(-1)?.event, "result")
})

test("missing task emits error and completes", async () => {
  const collected = await run(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<TaskEvent>()
      return yield* collectUntilDone(
        events,
        () => Effect.succeed(Option.none()),
        Effect.void,
      )
    }),
  )

  assert.equal(collected.at(-1)?.event, "error")
  assert.deepEqual(
    collected.filter((ev) => ev.event !== "ping").map((ev) => ev.event),
    ["task", "error"],
  )
})

test("encodeSse writes event and data lines", () => {
  const bytes = encodeSse({ event: "ping", data: { ts: 1 } })
  assert.equal(new TextDecoder().decode(bytes), "event: ping\ndata: {\"ts\":1}\n\n")
})
