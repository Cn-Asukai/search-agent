import { Effect, Layer, Duration, Fiber } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { AppConfig, AppConfigLive } from "./env.js"
import { OpenCode, OpenCodeLive, OpenCodeOpsLive } from "./services/opencode.js"
import { EventBridge, EventBridgeLive, eventLoop } from "./services/eventBridge.js"
import { TaskManager, TaskManagerLive, persistOpencodeTrace } from "./services/taskManager.js"
import { SearchRunnerLive } from "./services/searchRunner.js"
import { SqliteLive } from "./services/sqlite.js"
import { RoutesLayer } from "./http.js"

// ─────────────────────────────────────────────────────────────
// 应用组装:services layers + HttpRouter 路由层 → NodeHttpServer
// ─────────────────────────────────────────────────────────────

// services 层:mergeAll 全部 live layer(output 为全部服务)
// 各 layer 之间的依赖(如 SearchRunnerLive → TaskManager)由 Layer.provide 消化
// services 层:用 Layer.provide 逐层消化依赖,最终 RIn 为空
const OpenCodeWithConfig = OpenCodeLive.pipe(Layer.provide(AppConfigLive))
const SqliteWithConfig = SqliteLive.pipe(Layer.provide(AppConfigLive))
const TaskManagerWithDeps = TaskManagerLive.pipe(
  Layer.provide(Layer.mergeAll(AppConfigLive, SqliteWithConfig)),
)
const OpenCodeOpsWithDeps = OpenCodeOpsLive.pipe(
  Layer.provide(Layer.mergeAll(OpenCodeWithConfig, AppConfigLive, TaskManagerWithDeps)),
)
const SearchRunnerWithDeps = SearchRunnerLive.pipe(
  Layer.provide(
    Layer.mergeAll(OpenCodeWithConfig, OpenCodeOpsWithDeps, TaskManagerWithDeps, EventBridgeLive, AppConfigLive),
  ),
)
const ServicesLayer = Layer.mergeAll(
  AppConfigLive,
  OpenCodeWithConfig,
  OpenCodeOpsWithDeps,
  EventBridgeLive,
  TaskManagerWithDeps,
  SearchRunnerWithDeps,
)

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
  const tasks = yield* TaskManager

  console.log(`[search-agent] opencode: embedded @ ${opencode.url}`)
  console.log(`[search-agent] sqlite: ${config.sqlitePath}`)
  console.log(
    `[search-agent] 并发上限 ${config.maxConcurrency},单任务超时 ${Duration.toMillis(config.taskTimeout) / 1000}s,` +
      `agent=${config.opencodeAgent}${config.opencodeModel ? `,模型=${config.opencodeModel}` : "(模型取自 opencode.jsonc)"}`,
  )
  console.log(
    "[search-agent] 接口: POST /api/search {\"query\",\"type\",\"stream\"} | GET /api/search | GET /api/search/:id | GET /api/search/:id SSE | GET /api/health",
  )

  yield* persistOpencodeTrace(bridge.events, tasks).pipe(Effect.forkScoped)
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
