import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Duration, Effect, Layer, Option } from "effect"
import { AppConfig } from "../env.js"
import type { SearchResult } from "../domain/search.js"
import { SqliteLive } from "./sqlite.js"
import { STALE_TASK_ERROR } from "./sqlite.js"
import { TaskManager, TaskManagerLive } from "./taskManager.js"

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

function run<A>(sqlitePath: string, effect: Effect.Effect<A, never, TaskManager>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(tasksLayer(sqlitePath)))))
}

const sampleResult: SearchResult = {
  verdict: "none",
  confidence: "low",
  work: { original_title: "x", type: "other" },
  official: { exists: false },
  fan: { exists: false, translations: [] },
  sources: [],
  summary: "无",
}

test("create/get/update/progress/recent/stats round-trip", async () => {
  await run(":memory:", Effect.gen(function* () {
    const tasks = yield* TaskManager
    const created = yield* tasks.create("転生したら剣でした", "novel")
    assert.equal(created.status, "queued")
    assert.equal(created.progress.length, 0)
    assert.equal("opencode_trace" in created, false)

    const fetched = yield* tasks.get(created.id)
    assert.equal(Option.isSome(fetched), true)
    const task = Option.getOrThrow(fetched)
    assert.equal(task.query, "転生したら剣でした")
    assert.equal("opencode_trace" in task, false)

    yield* tasks.appendProgress(created.id, { kind: "status", message: "开始" })
    yield* tasks.update(created.id, {
      status: "done",
      result: sampleResult,
      endedAt: Date.now(),
    })

    const done = Option.getOrThrow(yield* tasks.get(created.id))
    assert.equal(done.status, "done")
    assert.equal(done.progress.length, 1)
    assert.equal(done.progress[0]?.seq, 1)
    assert.equal(done.result?.verdict, "none")
    assert.equal("opencode_trace" in done, false)

    const recent = yield* tasks.recent()
    assert.equal(recent.length, 1)
    const stats = yield* tasks.stats
    assert.equal(stats.total, 1)
    assert.equal(stats.queued, 0)
    assert.equal(stats.running, 0)
  }))
})

test("appendProgress assigns unique seq under concurrent writers", async () => {
  await run(":memory:", Effect.gen(function* () {
    const tasks = yield* TaskManager
    const created = yield* tasks.create("q", "unknown")
    yield* Effect.all(
      [
        tasks.appendProgress(created.id, { kind: "status", message: "a" }),
        tasks.appendProgress(created.id, { kind: "status", message: "b" }),
        tasks.appendProgress(created.id, { kind: "tool", message: "c", tool: "smartsearch" }),
      ],
      { concurrency: 3 },
    )
    const task = Option.getOrThrow(yield* tasks.get(created.id))
    assert.equal(task.progress.length, 3)
    const seqs = task.progress.map((p) => p.seq).sort((a, b) => a - b)
    assert.deepEqual(seqs, [1, 2, 3])
  }))
})

test("completed task and opencode_trace survive reopening the sqlite file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-agent-"))
  const sqlitePath = join(dir, "persist.sqlite")
  try {
    const id = await run(
      sqlitePath,
      Effect.gen(function* () {
        const tasks = yield* TaskManager
        const created = yield* tasks.create("転生したら剣でした", "novel")
        yield* tasks.appendProgress(created.id, { kind: "status", message: "开始" })
        yield* tasks.update(created.id, { sessionId: "ses_persist" })
        yield* tasks.appendTraceStep("ses_persist", {
          kind: "call",
          ts: 1,
          method: "session.create",
          durationMs: 2,
          response: { id: "ses_persist" },
        })
        yield* tasks.appendTraceStep("ses_persist", {
          kind: "event",
          ts: 3,
          type: "session.idle",
          properties: { sessionID: "ses_persist" },
        })
        yield* tasks.update(created.id, {
          status: "done",
          result: sampleResult,
          endedAt: Date.now(),
        })
        return created.id
      }),
    )
    await run(
      sqlitePath,
      Effect.gen(function* () {
        const tasks = yield* TaskManager
        const task = Option.getOrThrow(yield* tasks.get(id))
        assert.equal(task.status, "done")
        assert.equal(task.query, "転生したら剣でした")
        assert.equal(task.progress.length, 1)
        assert.equal(task.progress[0]?.message, "开始")
        assert.equal(task.result?.verdict, "none")
        assert.equal(task.sessionId, "ses_persist")
        assert.equal("opencode_trace" in task, false)

        const trace = Option.getOrThrow(yield* tasks.getTrace(id))
        assert.equal(trace.sessionId, "ses_persist")
        assert.equal(trace.steps.length, 2)
        assert.equal(trace.steps[0]?.kind, "call")
        assert.equal(trace.steps[1]?.kind, "event")
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("interruptStaleTasks marks queued/running as error on startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-agent-"))
  const sqlitePath = join(dir, "t.sqlite")
  try {
    const id = await run(
      sqlitePath,
      Effect.gen(function* () {
        const tasks = yield* TaskManager
        const created = yield* tasks.create("stale", "manga")
        yield* tasks.update(created.id, { status: "running", startedAt: Date.now() })
        return created.id
      }),
    )
    await run(
      sqlitePath,
      Effect.gen(function* () {
        const tasks = yield* TaskManager
        const task = Option.getOrThrow(yield* tasks.get(id))
        assert.equal(task.status, "error")
        assert.equal(task.error, STALE_TASK_ERROR)
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("unknown id is none", async () => {
  await run(":memory:", Effect.gen(function* () {
    const tasks = yield* TaskManager
    const missing = yield* tasks.get("no-such")
    assert.equal(Option.isNone(missing), true)
  }))
})
