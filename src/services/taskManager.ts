import { Context, Effect, Layer, Option, PubSub, Ref, Semaphore } from "effect"
import { AppConfig } from "../env.js"
import {
  ProgressEntry,
  type Task,
  type TaskEvent,
  type WorkType,
} from "../domain/search.js"
import { randomUUID } from "node:crypto"

// ─────────────────────────────────────────────────────────────
// 任务管理器:内存任务表 + 事件广播 + 并发信号量
// ─────────────────────────────────────────────────────────────

const MAX_PROGRESS_PER_TASK = 200
const MAX_TASKS = 500

export class TaskManager extends Context.Service<TaskManager, {
  readonly tasks: Ref.Ref<ReadonlyMap<string, Task>>
  readonly events: PubSub.PubSub<TaskEvent>
  readonly semaphore: Semaphore.Semaphore
  readonly create: (query: string, type: WorkType) => Effect.Effect<Task>
  readonly get: (id: string) => Effect.Effect<Option.Option<Task>>
  readonly update: (id: string, patch: Partial<Omit<Task, "id" | "progress">>) => Effect.Effect<void>
  readonly appendProgress: (id: string, entry: Omit<ProgressEntry, "seq" | "ts">) => Effect.Effect<void>
  readonly recent: (limit?: number) => Effect.Effect<readonly Task[]>
  readonly stats: Effect.Effect<{ total: number; queued: number; running: number }>
}>()("TaskManager") {}

/** TaskManager 服务的实例类型(= Shape) */
export type TaskManagerService = Context.Service.Shape<typeof TaskManager>

export const TaskManagerLive: Layer.Layer<TaskManager, never, AppConfig> = Layer.effect(
  TaskManager
)(Effect.gen(function* () {
    const config = yield* AppConfig
    const tasks = yield* Ref.make<ReadonlyMap<string, Task>>(new Map())
    const events = yield* PubSub.unbounded<TaskEvent>()
    const semaphore = yield* Semaphore.make(config.maxConcurrency)

    const emit = (event: TaskEvent) => PubSub.publish(events, event).pipe(Effect.ignore)

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
        yield* Ref.update(tasks, (map) => {
          const next = new Map(map)
          next.set(task.id, task)
          evictOld(next)
          return next
        })
        return task
      })

    const get = (id: string) =>
      Ref.get(tasks).pipe(
        Effect.map((map) => {
          const task = map.get(id)
          return task ? Option.some(task) : Option.none()
        }),
      )

    const update = (id: string, patch: Partial<Omit<Task, "id" | "progress">>) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(tasks)
        const existing = map.get(id)
        if (!existing) return
        const updated: Task = { ...existing, ...patch, updatedAt: Date.now() }
        yield* Ref.update(tasks, (m) => new Map(m).set(id, updated))
        if (patch.status === "done") yield* emit({ _tag: "done", task: updated })
        if (patch.status === "error") yield* emit({ _tag: "error", task: updated })
      })

    const appendProgress = (id: string, entry: Omit<ProgressEntry, "seq" | "ts">) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(tasks)
        const task = map.get(id)
        if (!task) return
        const full: ProgressEntry = {
          ...entry,
          seq: task.progress.length + 1,
          ts: Date.now(),
        }
        const progress = [...task.progress, full]
        if (progress.length > MAX_PROGRESS_PER_TASK) {
          progress.splice(0, progress.length - MAX_PROGRESS_PER_TASK)
        }
        const updated: Task = { ...task, progress, updatedAt: full.ts }
        yield* Ref.update(tasks, (m) => new Map(m).set(id, updated))
        yield* emit({ _tag: "progress", task: updated, entry: full })
      })

    const recent = (limit = 50) =>
      Ref.get(tasks).pipe(
        Effect.map((map) =>
          [...map.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
        ),
      )

    const stats = Effect.gen(function* () {
      const map = yield* Ref.get(tasks)
      let queued = 0
      let running = 0
      for (const t of map.values()) {
        if (t.status === "queued") queued++
        else if (t.status === "running") running++
      }
      return { total: map.size, queued, running }
    })

    return { tasks, events, semaphore, create, get, update, appendProgress, recent, stats }
  }))

function evictOld(map: Map<string, Task>): void {
  if (map.size <= MAX_TASKS) return
  const finished = [...map.values()]
    .filter((t) => t.status === "done" || t.status === "error")
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const toRemove = map.size - MAX_TASKS
  for (let i = 0; i < Math.min(toRemove, finished.length); i++) {
    map.delete(finished[i]!.id)
  }
}

// 便捷访问器(供 handler 使用)
export const taskManagerGet = (id: string) =>
  Effect.flatMap(TaskManager, (tm) => tm.get(id))
export const taskManagerRecent = () =>
  Effect.flatMap(TaskManager, (tm) => tm.recent())
export const taskManagerStats = () => Effect.flatMap(TaskManager, (tm) => tm.stats)
