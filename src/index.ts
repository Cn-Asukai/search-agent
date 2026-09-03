import { Effect, Layer, Duration, Fiber, Stream, Schedule, Option, Schema } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { AppConfig, AppConfigLive, type AppConfigService } from "./env.js"
import { OpenCode, OpenCodeLive, OpenCodeOps, OpenCodeOpsLive } from "./services/opencode.js"
import { EventBridge, EventBridgeLive, eventLoop } from "./services/eventBridge.js"
import { TaskManager, TaskManagerLive, type TaskManagerService } from "./services/taskManager.js"
import { SearchRunner, SearchRunnerLive } from "./services/searchRunner.js"
import type { SseClientEvent, TaskEvent } from "./domain/search.js"

// ─────────────────────────────────────────────────────────────
// 应用组装:services layers + HttpRouter 路由层 → NodeHttpServer
// ─────────────────────────────────────────────────────────────

// services 层:mergeAll 全部 live layer(output 为全部服务)
// 各 layer 之间的依赖(如 SearchRunnerLive → TaskManager)由 Layer.provide 消化
// services 层:用 Layer.provide 逐层消化依赖,最终 RIn 为空
const OpenCodeWithConfig = OpenCodeLive.pipe(Layer.provide(AppConfigLive))
const TaskManagerWithConfig = TaskManagerLive.pipe(Layer.provide(AppConfigLive))
const OpenCodeOpsWithDeps = OpenCodeOpsLive.pipe(
  Layer.provide(Layer.mergeAll(OpenCodeWithConfig, AppConfigLive)),
)
const SearchRunnerWithDeps = SearchRunnerLive.pipe(
  Layer.provide(
    Layer.mergeAll(OpenCodeWithConfig, OpenCodeOpsWithDeps, TaskManagerWithConfig, EventBridgeLive, AppConfigLive),
  ),
)
const ServicesLayer = Layer.mergeAll(
  AppConfigLive,
  OpenCodeWithConfig,
  OpenCodeOpsWithDeps,
  EventBridgeLive,
  TaskManagerWithConfig,
  SearchRunnerWithDeps,
)

// ─────────────────────────────────────────────────────────────
// HTTP 路由(handler 通过 Effect 依赖注入 services)
// ─────────────────────────────────────────────────────────────

const SearchRequestSchema = Schema.Struct({
  query: Schema.NonEmptyString,
  type: Schema.optional(Schema.Literals(["novel", "manga", "unknown"])),
  stream: Schema.optional(Schema.Boolean),
})

const healthRoute = HttpRouter.add("GET", "/health", () =>
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
    const taskOpt = yield* tasks.get(id)
    if (Option.isNone(taskOpt)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "任务不存在(服务重启后内存任务会被清除)" },
        { status: 404 },
      )
    }
    return HttpServerResponse.jsonUnsafe(Option.getOrThrow(taskOpt))
  }),
)

const RoutesLayer = Layer.mergeAll(healthRoute, searchRoute, searchListRoute, searchByIdRoute)

// ─────────────────────────────────────────────────────────────
// 响应实现
// ─────────────────────────────────────────────────────────────

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

/** SSE 模式:task → progress... → result / error;15s 心跳 */
function sseResponse(
  taskId: string,
  tasks: TaskManagerService,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  const events: Stream.Stream<SseClientEvent> = Stream.fromPubSub(tasks.events).pipe(
    Stream.filter((ev): ev is TaskEvent => ev.task.id === taskId),
    Stream.map((ev): SseClientEvent => {
      switch (ev._tag) {
        case "progress":
          return { event: "progress", data: ev.entry }
        case "done":
          return { event: "result", data: ev.task }
        case "error":
          return { event: "error", data: ev.task }
      }
    }),
  )

  const initial: Stream.Stream<SseClientEvent> = Stream.fromEffect(
    tasks.get(taskId).pipe(
      Effect.map((t) => ({ event: "task" as const, data: Option.getOrNull(t) })),
    ),
  )

  const heartbeat: Stream.Stream<SseClientEvent> = Stream.fromEffectSchedule(
    Effect.sync((): SseClientEvent => ({ event: "ping", data: { ts: Date.now() } })),
    Schedule.spaced("15 seconds"),
  )

  const all: Stream.Stream<SseClientEvent> = Stream.merge(initial, Stream.merge(events, heartbeat))

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

function encodeSse(ev: SseClientEvent): Uint8Array {
  const payload = JSON.stringify(ev.data)
  const lines = [`event: ${ev.event}`, `data: ${payload}`, "", ""]
  return new TextEncoder().encode(lines.join("\n"))
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

const HttpServerLayer = NodeHttpServer.layer(createServer, { port: 8787 })

// 路由层 → serve(直接调用)→ 提供 HttpServer
const HttpAppLayer = HttpRouter.serve(RoutesLayer).pipe(
  Layer.provide(HttpServerLayer),
)

// program:启动事件桥并保持运行(services 由 context 提供)
const program = Effect.gen(function* () {
  const config = yield* AppConfig
  const opencode = yield* OpenCode
  const bridge = yield* EventBridge

  console.log(`[search-agent] opencode: embedded @ ${opencode.url}`)
  console.log(
    `[search-agent] 并发上限 ${config.maxConcurrency},单任务超时 ${Duration.toMillis(config.taskTimeout) / 1000}s,` +
      `agent=${config.opencodeAgent}${config.opencodeModel ? `,模型=${config.opencodeModel}` : "(模型取自 opencode.jsonc)"}`,
  )
  console.log(
    "[search-agent] 接口: POST /api/search {\"query\",\"type\",\"stream\"} | GET /api/search | GET /api/search/:id | GET /health",
  )

  yield* eventLoop(opencode.client, bridge.events).pipe(Effect.forkScoped)
  yield* Effect.never
})

// 先构建 services context(scoped),再提供;HTTP 层作为 scoped 资源同时运行
// 事件桥随 program 启动;HTTP 层与 program 都由 services 提供
const runnable = Effect.scoped(
  Effect.gen(function* () {
    // 构建 services context,再提供给 HTTP 与 program
    const ctx = yield* Layer.build(ServicesLayer)
    const httpFiber = yield* Effect.provideContext(ctx)(Layer.launch(HttpAppLayer)).pipe(Effect.forkScoped)
    yield* Effect.provideContext(ctx)(program)
    yield* Fiber.interrupt(httpFiber)
  }),
)

// 用 runPromise 代替 runMain(NodeRuntime 的 keep-alive 与 Effect.sleep 冲突)
Effect.runPromise(runnable).catch((err) => {
  console.error("[search-agent] 启动失败:", err)
  process.exit(1)
})
