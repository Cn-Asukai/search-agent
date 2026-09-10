import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, PubSub, Schema, Semaphore, Stream, type Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AppConfig } from "../env.js"
import {
  OpencodeTrace,
  ProgressEntry,
  SearchResult,
  type OpencodeTraceStep,
  type Task,
  type TaskEvent,
  type WorkType,
} from "../domain/search.js"
import { logWarn } from "../log.js"
import { STALE_TASK_ERROR } from "./sqlite.js"
import type { OpencodeEvent } from "./eventBridge.js"

// ─────────────────────────────────────────────────────────────
// 任务管理器:SQLite 任务表 + 事件广播 + 并发信号量
// progress_json 给客户端;opencode_trace 只落库,get/recent 不读
// ─────────────────────────────────────────────────────────────

type TaskRow = {
  readonly id: string
  readonly query: string
  readonly type: string
  readonly status: string
  readonly created_at: number
  readonly updated_at: number
  readonly started_at: number | null
  readonly ended_at: number | null
  readonly session_id: string | null
  readonly progress_json: string
  readonly result_json: string | null
  readonly error: string | null
}

export class TaskManager extends Context.Service<TaskManager, {
  readonly events: PubSub.PubSub<TaskEvent>
  readonly semaphore: Semaphore.Semaphore
  readonly create: (query: string, type: WorkType) => Effect.Effect<Task>
  readonly get: (id: string) => Effect.Effect<Option.Option<Task>>
  readonly update: (id: string, patch: Partial<Omit<Task, "id" | "progress">>) => Effect.Effect<void>
  readonly appendProgress: (id: string, entry: Omit<ProgressEntry, "seq" | "ts">) => Effect.Effect<void>
  readonly appendTraceStep: (sessionId: string, step: OpencodeTraceStep) => Effect.Effect<void>
  readonly getTrace: (taskId: string) => Effect.Effect<Option.Option<OpencodeTrace>>
  readonly recent: (limit?: number) => Effect.Effect<readonly Task[]>
  readonly stats: Effect.Effect<{ total: number; queued: number; running: number }>
}>()("TaskManager") {}

/** TaskManager 服务的实例类型(= Shape) */
export type TaskManagerService = Context.Service.Shape<typeof TaskManager>

export const TaskManagerLive: Layer.Layer<TaskManager, never, AppConfig | SqlClient.SqlClient> = Layer.effect(
  TaskManager,
)(Effect.gen(function* () {
  const config = yield* AppConfig
  const sql = yield* SqlClient.SqlClient
  const events = yield* PubSub.unbounded<TaskEvent>()
  const semaphore = yield* Semaphore.make(config.maxConcurrency)

  yield* interruptStaleTasks(sql)

  const emit = (event: TaskEvent) => PubSub.publish(events, event).pipe(Effect.ignore)

  const get = (id: string) =>
    sql<TaskRow>`
      SELECT id, query, type, status, created_at, updated_at, started_at, ended_at,
             session_id, progress_json, result_json, error
      FROM tasks WHERE id = ${id}
    `.pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row ? Option.some(rowToTask(row)) : Option.none()
      }),
      Effect.orDie,
    )

  const create = (query: string, type: WorkType) =>
    Effect.gen(function* () {
      const now = Date.now()
      const task: Task = {
        id: randomUUID(),
        query,
        type,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        progress: [],
      }
      yield* sql`
        INSERT INTO tasks (
          id, query, type, status, created_at, updated_at,
          started_at, ended_at, session_id, progress_json, result_json, error, opencode_trace
        ) VALUES (
          ${task.id}, ${task.query}, ${task.type}, ${task.status}, ${now}, ${now},
          ${null}, ${null}, ${null}, ${"[]"}, ${null}, ${null}, ${null}
        )
      `.pipe(Effect.orDie)
      yield* enforceTaskRetention.pipe(Effect.orDie)
      return task
    })

  const update = (id: string, patch: Partial<Omit<Task, "id" | "progress">>) =>
    Effect.gen(function* () {
      const existingOpt = yield* get(id)
      if (Option.isNone(existingOpt)) return
      const existing = existingOpt.value
      const now = Date.now()
      const updated: Task = { ...existing, ...patch, updatedAt: now }
      yield* sql`
        UPDATE tasks SET
          query = ${updated.query},
          type = ${updated.type},
          status = ${updated.status},
          updated_at = ${now},
          started_at = ${updated.startedAt ?? null},
          ended_at = ${updated.endedAt ?? null},
          session_id = ${updated.sessionId ?? null},
          result_json = ${updated.result ? JSON.stringify(updated.result) : null},
          error = ${updated.error ?? null}
        WHERE id = ${id}
      `.pipe(Effect.orDie)
      if (patch.sessionId) {
        const initial = JSON.stringify({ sessionId: patch.sessionId, steps: [] })
        yield* sql`
          UPDATE tasks
          SET opencode_trace = COALESCE(opencode_trace, ${initial})
          WHERE id = ${id}
        `.pipe(Effect.orDie)
      }
      if (patch.status === "done") yield* emit({ _tag: "done", task: updated })
      if (patch.status === "error") yield* emit({ _tag: "error", task: updated })
    })

  const appendProgress = (id: string, entry: Omit<ProgressEntry, "seq" | "ts">) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<TaskRow>`
          SELECT id, query, type, status, created_at, updated_at, started_at, ended_at,
                 session_id, progress_json, result_json, error
          FROM tasks WHERE id = ${id}
        `
        const row = rows[0]
        if (!row) return
        const progress = parseProgress(row.progress_json)
        const full: ProgressEntry = {
          ...entry,
          seq: (progress[progress.length - 1]?.seq ?? 0) + 1,
          ts: Date.now(),
        }
        progress.push(full)
        if (progress.length > config.progressRetention) {
          progress.splice(0, progress.length - config.progressRetention)
        }
        yield* sql`
          UPDATE tasks
          SET progress_json = ${JSON.stringify(progress)}, updated_at = ${full.ts}
          WHERE id = ${id}
        `
        const updated = rowToTask({
          ...row,
          progress_json: JSON.stringify(progress),
          updated_at: full.ts,
        })
        yield* emit({ _tag: "progress", task: updated, entry: full })
      }),
    ).pipe(Effect.orDie)

  const appendTraceStep = (sessionId: string, step: OpencodeTraceStep) =>
    Effect.try({
      try: () => JSON.stringify(step),
      catch: (err) => err,
    }).pipe(
      Effect.flatMap((stepJson) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ opencode_trace: string | null }>`
              SELECT opencode_trace FROM tasks WHERE session_id = ${sessionId}
            `
            const row = rows[0]
            if (!row) return
            const parsed = parseTraceJson(row.opencode_trace, sessionId)
            parsed.steps.push(JSON.parse(stepJson) as OpencodeTraceStep)
            if (parsed.steps.length > config.traceStepRetention) {
              parsed.steps.splice(0, parsed.steps.length - config.traceStepRetention)
            }
            yield* sql`
              UPDATE tasks
              SET opencode_trace = ${JSON.stringify(parsed)}
              WHERE session_id = ${sessionId}
            `
          }),
        ),
      ),
      Effect.catch((err) =>
        Effect.sync(() => {
          logWarn("task-manager", "写入 opencode_trace 失败", err)
        }),
      ),
    )

  const getTrace = (taskId: string) =>
    sql<{ opencode_trace: string | null }>`
      SELECT opencode_trace FROM tasks WHERE id = ${taskId}
    `.pipe(
      Effect.map((rows) => {
        const raw = rows[0]?.opencode_trace
        if (!raw) return Option.none()
        try {
          return Schema.decodeUnknownOption(OpencodeTrace)(JSON.parse(raw))
        } catch {
          return Option.none()
        }
      }),
      Effect.orDie,
    )

  const recent = (limit = 50) =>
    sql<TaskRow>`
      SELECT id, query, type, status, created_at, updated_at, started_at, ended_at,
             session_id, progress_json, result_json, error
      FROM tasks ORDER BY created_at DESC LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map(rowToTask)),
      Effect.orDie,
    )

  const stats = sql<{ total: number | null; queued: number | null; running: number | null }>`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM tasks
  `.pipe(
    Effect.map((rows) => {
      const row = rows[0]
      return {
        total: Number(row?.total ?? 0),
        queued: Number(row?.queued ?? 0),
        running: Number(row?.running ?? 0),
      }
    }),
    Effect.orDie,
  )

  const enforceTaskRetention = Effect.gen(function* () {
    const limit = config.taskRetention
    const counted = yield* sql<{ total: number | null }>`SELECT COUNT(*) AS total FROM tasks`
    const excess = Number(counted[0]?.total ?? 0) - limit
    if (excess <= 0) return
    yield* sql`
      DELETE FROM tasks WHERE id IN (
        SELECT id FROM tasks
        WHERE status IN ('done', 'error')
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${excess}
      )
    `
    const again = yield* sql<{ total: number | null }>`SELECT COUNT(*) AS total FROM tasks`
    const still = Number(again[0]?.total ?? 0) - limit
    if (still <= 0) return
    yield* sql`
      DELETE FROM tasks WHERE id IN (
        SELECT id FROM tasks
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${still}
      )
    `
  })

  return { events, semaphore, create, get, update, appendProgress, appendTraceStep, getTrace, recent, stats }
}))

function interruptStaleTasks(sql: SqlClient.SqlClient): Effect.Effect<void> {
  const now = Date.now()
  return sql`
    UPDATE tasks
    SET status = 'error',
        error = ${STALE_TASK_ERROR},
        ended_at = ${now},
        updated_at = ${now}
    WHERE status IN ('queued', 'running')
  `.pipe(Effect.orDie, Effect.as(undefined as void))
}

/** 把 EventBridge 的原始 SSE 追加进对应任务的 opencode_trace;无 sessionID 则丢弃 */
export const persistOpencodeTrace = (
  events: PubSub.PubSub<OpencodeEvent>,
  tasks: TaskManagerService,
): Effect.Effect<void, never, Scope.Scope> =>
  Stream.fromPubSub(events).pipe(
    Stream.runForEach((event) => {
      const sessionID = event.properties?.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) return Effect.void
      return tasks.appendTraceStep(sessionID, {
        kind: "event",
        ts: Date.now(),
        type: event.type,
        properties: event.properties,
      })
    }),
  )

function rowToTask(row: TaskRow): Task {
  const result = parseResult(row.result_json)
  return {
    id: row.id,
    query: row.query,
    type: row.type as WorkType,
    status: row.status as Task["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress: parseProgress(row.progress_json),
    ...(row.started_at != null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at != null ? { endedAt: row.ended_at } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(result ? { result } : {}),
    ...(row.error ? { error: row.error } : {}),
  }
}

function parseProgress(raw: string): ProgressEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      const decoded = Schema.decodeUnknownOption(ProgressEntry)(item)
      return decoded._tag === "Some" ? [decoded.value] : []
    })
  } catch {
    return []
  }
}

function parseTraceJson(raw: string | null, sessionId: string): { sessionId: string; steps: OpencodeTraceStep[] } {
  if (!raw) return { sessionId, steps: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return { sessionId, steps: [] }
    const rec = parsed as { sessionId?: unknown; steps?: unknown }
    const sid = typeof rec.sessionId === "string" && rec.sessionId.length > 0 ? rec.sessionId : sessionId
    const steps = Array.isArray(rec.steps) ? (rec.steps as OpencodeTraceStep[]) : []
    return { sessionId: sid, steps }
  } catch {
    return { sessionId, steps: [] }
  }
}

function parseResult(raw: string | null): SearchResult | undefined {
  if (!raw) return undefined
  try {
    const decoded = Schema.decodeUnknownOption(SearchResult)(JSON.parse(raw))
    return decoded._tag === "Some" ? decoded.value : undefined
  } catch {
    return undefined
  }
}

// 便捷访问器(供 handler 使用)
export const taskManagerGet = (id: string) =>
  Effect.flatMap(TaskManager, (tm) => tm.get(id))
export const taskManagerRecent = () =>
  Effect.flatMap(TaskManager, (tm) => tm.recent())
export const taskManagerStats = () => Effect.flatMap(TaskManager, (tm) => tm.stats)
