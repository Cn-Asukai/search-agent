import { timingSafeEqual } from "node:crypto"
import { Effect, Layer, Option, PubSub, Redacted, Schema, Stream, type Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { AppConfig, type AppConfigService } from "./env.js"
import { SearchRequest, type Task } from "./domain/search.js"
import { OpenCode, OpenCodeOps } from "./services/opencode.js"
import { TaskManager, type TaskManagerService } from "./services/taskManager.js"
import { SearchRunner } from "./services/searchRunner.js"
import { buildSearchSseStream, encodeSse } from "./services/sseStream.js"
import { readRevision, resolveAppVersion } from "./services/appVersion.js"
import { logInfo, logWarn } from "./log.js"

const APP_VERSION = resolveAppVersion(process.env.GIT_VERSION)

const unauthorized = HttpServerResponse.jsonUnsafe({ error: "未授权" }, { status: 401 })

function equalSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim()
  return token ? token : undefined
}

/** Bearer 中间件:未配置 apiAuthKey 则放行;/api/health 豁免;失败 401 JSON */
const bearerAuth = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const q = request.url.indexOf("?")
    const path = q === -1 ? request.url : request.url.slice(0, q)
    if (path === "/api/health") {
      return yield* httpEffect
    }
    const config = yield* AppConfig
    if (config.apiAuthKey === undefined) {
      return yield* httpEffect
    }
    const expected = Redacted.value(config.apiAuthKey)
    const token = bearerToken(request.headers["authorization"])
    if (token === undefined || !equalSecret(expected, token)) {
      return unauthorized
    }
    return yield* httpEffect
  }), { global: true })

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
    const raw = yield* req.json.pipe(Effect.option)
    if (Option.isNone(raw)) {
      return HttpServerResponse.jsonUnsafe({ error: "请求参数不合法" }, { status: 400 })
    }
    const body = raw.value !== null && typeof raw.value === "object" && !Array.isArray(raw.value)
      ? raw.value as Record<string, unknown>
      : {}
    const parsed = Schema.decodeUnknownOption(SearchRequest)({
      ...body,
      type: body.type ?? "unknown",
      stream: body.stream ?? false,
    })
    if (Option.isNone(parsed)) {
      return HttpServerResponse.jsonUnsafe({ error: "请求参数不合法" }, { status: 400 })
    }
    const payload = parsed.value
    const task = yield* tasks.create(payload.query, payload.type)
    yield* runner.launch(task.id)
    if (payload.stream) {
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
        return HttpServerResponse.jsonUnsafe({ error: "任务不存在" }, { status: 404 })
      }
      return yield* sseResponse(id, tasks)
    }
    const taskOpt = yield* tasks.get(id)
    if (Option.isNone(taskOpt)) {
      return HttpServerResponse.jsonUnsafe({ error: "任务不存在" }, { status: 404 })
    }
    return HttpServerResponse.jsonUnsafe(Option.getOrThrow(taskOpt))
  }),
)

const abortRoute = HttpRouter.add("POST", "/api/search/:id/abort", () =>
  Effect.gen(function* () {
    const tasks = yield* TaskManager
    const ops = yield* OpenCodeOps
    const params = yield* HttpRouter.params
    const id = params.id
    if (!id) {
      return HttpServerResponse.jsonUnsafe({ error: "缺少任务 id" }, { status: 400 })
    }
    const taskOpt = yield* tasks.get(id)
    if (Option.isNone(taskOpt)) {
      return HttpServerResponse.jsonUnsafe({ error: "任务不存在" }, { status: 404 })
    }
    const task = taskOpt.value
    if (task.status === "done" || task.status === "error") {
      return HttpServerResponse.jsonUnsafe(task, { status: 200 })
    }
    logInfo("http", `取消任务 id=${id}${task.sessionId ? ` session=${task.sessionId}` : ""}`)
    if (task.sessionId) {
      yield* ops.abortSession(task.sessionId).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            logWarn("http", `中止会话失败 id=${id} session=${task.sessionId}`, err)
          }),
        ),
      )
    }
    yield* tasks.update(id, {
      status: "error",
      error: "已取消",
      endedAt: Date.now(),
    })
    const updated = yield* tasks.get(id)
    return HttpServerResponse.jsonUnsafe(
      Option.getOrElse(updated, () => ({ ...task, status: "error" as const, error: "已取消" })),
      { status: 200 },
    )
  }),
)

export const RoutesLayer = Layer.mergeAll(
  healthRoute,
  searchRoute,
  searchListRoute,
  searchByIdRoute,
  abortRoute,
  bearerAuth,
)

function taskJson(task: Task): HttpServerResponse.HttpServerResponse {
  // 业务失败是任务状态,不是 HTTP 故障;不要 500,避免负载均衡重试再烧模型
  return HttpServerResponse.jsonUnsafe(task, { status: 200 })
}

/** 同步模式:与 SSE 同构,先订 PubSub 再读快照;超时 202 带 id/status */
function syncResponse(
  taskId: string,
  tasks: TaskManagerService,
  config: AppConfigService,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope> {
  return Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(tasks.events)
    const snapshot = yield* tasks.get(taskId)
    if (Option.isSome(snapshot) && (snapshot.value.status === "done" || snapshot.value.status === "error")) {
      return taskJson(snapshot.value)
    }
    const live = Stream.fromSubscription(subscription).pipe(
      Stream.filter((ev) => ev.task.id === taskId && (ev._tag === "done" || ev._tag === "error")),
      Stream.take(1),
      Stream.runHead,
    )
    const maybeEvent = yield* live.pipe(
      Effect.timeoutOrElse({
        duration: config.syncMaxWait,
        orElse: () => Effect.succeed(Option.none()),
      }),
    )
    if (Option.isSome(maybeEvent)) {
      return taskJson(maybeEvent.value.task)
    }
    const again = yield* tasks.get(taskId)
    if (Option.isSome(again) && (again.value.status === "done" || again.value.status === "error")) {
      return taskJson(again.value)
    }
    return HttpServerResponse.jsonUnsafe(
      {
        id: taskId,
        status: Option.isSome(again) ? again.value.status : "queued",
        error: "等待超时",
        note: "请稍后通过 GET /api/search/:id 获取结果",
      },
      { status: 202 },
    )
  })
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
