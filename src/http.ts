import { Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { AppConfig, type AppConfigService } from "./env.js"
import { OpenCode, OpenCodeOps } from "./services/opencode.js"
import { TaskManager, type TaskManagerService } from "./services/taskManager.js"
import { SearchRunner } from "./services/searchRunner.js"
import { buildSearchSseStream, encodeSse } from "./services/sseStream.js"
import { readRevision, resolveAppVersion } from "./services/appVersion.js"

const APP_VERSION = resolveAppVersion(process.env.GIT_VERSION)

const SearchRequestSchema = Schema.Struct({
  query: Schema.NonEmptyString,
  type: Schema.optional(Schema.Literals(["novel", "manga", "unknown"])),
  stream: Schema.optional(Schema.Boolean),
})

const healthRoute = HttpRouter.add("GET", "/api/health", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskManager
    const opencode = yield* OpenCode
    const ops = yield* OpenCodeOps
    const config = yield* AppConfig
    const health = yield* ops.health
    const taskStats = yield* tasks.stats
    return HttpServerResponse.jsonUnsafe({
      status: health.ok ? "ok" : "degraded",
      service: "search-agent",
      version: APP_VERSION,
      revision: readRevision(process.env.GIT_REVISION),
      opencode: {
        url: opencode.url,
        healthy: health.ok,
        version: health.version,
      },
      runner: {
        active: taskStats.running,
        limit: config.maxConcurrency,
        queued: taskStats.queued,
        running: taskStats.running,
      },
      tasks: taskStats,
      time: new Date().toISOString(),
    })
  }),
)

const searchRoute = HttpRouter.add("POST", "/api/search", (req) =>
  Effect.gen(function* () {
    const runner = yield* SearchRunner
    const tasks = yield* TaskManager
    const config = yield* AppConfig
    const raw = yield* req.json
    const parsed = Schema.decodeUnknownOption(SearchRequestSchema)(raw)
    if (Option.isNone(parsed)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "请求参数不合法" },
        { status: 400 },
      )
    }
    const payload = parsed.value
    const task = yield* tasks.create(payload.query, payload.type ?? "unknown")
    yield* runner.launch(task.id)
    if (payload.stream ?? false) {
      return yield* sseResponse(task.id, tasks)
    }
    return yield* syncResponse(task.id, tasks, config)
  }),
)

const searchListRoute = HttpRouter.add("GET", "/api/search", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskManager
    const recent = yield* tasks.recent()
    return HttpServerResponse.jsonUnsafe({
      tasks: recent.map((t) => ({
        id: t.id,
        query: t.query,
        type: t.type,
        status: t.status,
        createdAt: t.createdAt,
        endedAt: t.endedAt,
        error: t.error,
      })),
    })
  }),
)

const searchByIdRoute = HttpRouter.add("GET", "/api/search/:id", (req) =>
  Effect.gen(function* () {
    const tasks = yield* TaskManager
    const params = yield* HttpRouter.params
    const id = params.id
    if (!id) {
      return HttpServerResponse.jsonUnsafe({ error: "缺少任务 id" }, { status: 400 })
    }
    if (wantsSse(req)) {
      const taskOpt = yield* tasks.get(id)
      if (Option.isNone(taskOpt)) {
        return HttpServerResponse.jsonUnsafe(
          { error: "任务不存在" },
          { status: 404 },
        )
      }
      return yield* sseResponse(id, tasks)
    }
    const taskOpt = yield* tasks.get(id)
    if (Option.isNone(taskOpt)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "任务不存在" },
        { status: 404 },
      )
    }
    return HttpServerResponse.jsonUnsafe(Option.getOrThrow(taskOpt))
  }),
)

export const RoutesLayer = Layer.mergeAll(healthRoute, searchRoute, searchListRoute, searchByIdRoute)

/** 同步模式:等待任务终态;超过 SYNC_MAX_WAIT 返回 202 */
function syncResponse(
  taskId: string,
  tasks: TaskManagerService,
  config: AppConfigService,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  const wait = Effect.gen(function* () {
    yield* Stream.fromPubSub(tasks.events).pipe(
      Stream.takeWhile((ev) => !(ev.task.id === taskId && (ev._tag === "done" || ev._tag === "error"))),
      Stream.runDrain,
    )
    const task = yield* tasks.get(taskId)
    return Option.getOrNull(task)
  }).pipe(
    Effect.timeoutOrElse({
      duration: config.syncMaxWait,
      orElse: () => Effect.succeed(null),
    }),
  )

  return wait.pipe(
    Effect.map((task) => {
      if (task === null) {
        return HttpServerResponse.jsonUnsafe(
          { error: "等待超时", note: "请稍后通过 GET /api/search/:id 获取结果" },
          { status: 202 },
        )
      }
      if (task.status === "error") {
        return HttpServerResponse.jsonUnsafe(task, { status: 500 })
      }
      return HttpServerResponse.jsonUnsafe(task, { status: 200 })
    }),
  )
}

function wantsSse(req: { readonly headers: { readonly [key: string]: string }; readonly url: string }): boolean {
  const accept = req.headers["accept"] ?? ""
  if (accept.includes("text/event-stream")) return true
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : ""
  return new URLSearchParams(query).get("stream") === "true"
}

function sseResponse(
  taskId: string,
  tasks: TaskManagerService,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  const all = buildSearchSseStream({
    taskId,
    events: tasks.events,
    getTask: tasks.get,
  })

  return Effect.succeed(
    HttpServerResponse.stream(all.pipe(Stream.map(encodeSse)), {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }),
  )
}
