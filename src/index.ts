import { Effect, Layer, Duration, Deferred } from "effect"
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

const HttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    return NodeHttpServer.layer(createServer, { port: config.port, host: config.host })
  }),
)

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
    "[search-agent] 接口: POST /api/search {\"query\",\"type\",\"stream\"} | GET /api/search | GET /api/search/:id | GET /api/search/:id SSE | POST /api/search/:id/abort | GET /api/health",
  )

  const ready = yield* Deferred.make<void>()
  yield* persistOpencodeTrace(bridge.events, tasks).pipe(Effect.forkScoped)
  yield* eventLoop(opencode.client, bridge.events, ready).pipe(Effect.forkScoped)
  yield* Deferred.await(ready)

  console.log(`[search-agent] HTTP 监听 ${config.host}:${config.port}`)
  yield* Layer.launch(HttpAppLayer)
})

const runnable = Effect.scoped(program.pipe(Effect.provide(ServicesLayer)))

// 用 runPromise 代替 runMain(NodeRuntime 的 keep-alive 与 Effect.sleep 冲突)
Effect.runPromise(runnable).catch((err) => {
  console.error("[search-agent] 启动失败:", err)
  process.exit(1)
})
