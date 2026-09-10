import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Duration, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { AppConfig } from "./env.js"
import { RoutesLayer } from "./http.js"
import { OpenCode, OpenCodeOps } from "./services/opencode.js"
import { SearchRunner } from "./services/searchRunner.js"
import { SqliteLive } from "./services/sqlite.js"
import { TaskManagerLive } from "./services/taskManager.js"

function configLive() {
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
      maxConcurrency: 3,
      syncMaxWait: Duration.millis(80),
      apiAuthKey: undefined,
      sqlitePath: ":memory:",
    }),
  )
}

const OpenCodeTest = Layer.succeed(
  OpenCode,
  OpenCode.of({
    client: {} as OpencodeClient,
    url: "http://127.0.0.1:9",
    close: () => undefined,
  }),
)

const OpenCodeOpsTest = Layer.succeed(
  OpenCodeOps,
  OpenCodeOps.of({
    createSession: Effect.succeed("ses_http"),
    submitSearch: () => Effect.void,
    getLatestAssistant: () => Effect.fail(new Error("未找到模型回复")),
    abortSession: () => Effect.void,
    health: Effect.succeed({ ok: true, version: "test-opencode" }),
  }),
)

const IdleRunner = Layer.succeed(
  SearchRunner,
  SearchRunner.of({
    launch: () => Effect.void,
  }),
)

function servicesLayer() {
  const config = configLive()
  const tasks = TaskManagerLive.pipe(Layer.provideMerge(SqliteLive), Layer.provide(config))
  return Layer.mergeAll(IdleRunner, tasks, OpenCodeTest, OpenCodeOpsTest, config)
}

async function withHandler<A>(
  use: (handler: (request: Request) => Promise<Response>) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = createServer()
        const ctx = yield* Layer.build(servicesLayer())
        const httpLayer = HttpRouter.serve(RoutesLayer, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provide(NodeHttpServer.layer(() => server, { port: 0 })),
        )
        yield* Effect.provideContext(ctx)(Layer.launch(httpLayer)).pipe(Effect.forkScoped)
        yield* Effect.callback<void>((resume) => {
          if (server.listening) resume(Effect.void)
          else server.once("listening", () => resume(Effect.void))
        })
        const addr = server.address() as AddressInfo
        const origin = `http://127.0.0.1:${addr.port}`
        const handler = async (request: Request): Promise<Response> => {
          const url = new URL(request.url)
          const hasBody = request.method !== "GET" && request.method !== "HEAD"
          return fetch(`${origin}${url.pathname}${url.search}`, {
            method: request.method,
            headers: request.headers,
            body: hasBody ? await request.arrayBuffer() : undefined,
          })
        }
        return yield* Effect.promise(() => use(handler))
      }),
    ),
  )
}

async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(await res.text()) as unknown
}

test("POST /api/search rejects illegal bodies with 400", async () => {
  await withHandler(async (handler) => {
    const cases: unknown[] = [
      {},
      { query: "" },
      { query: "x", type: "film" },
      { query: "x", stream: "yes" },
    ]
    for (const body of cases) {
      const res = await handler(
        new Request("http://127.0.0.1/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
      const json = (await readJson(res)) as { error?: string }
      assert.equal(json.error, "请求参数不合法")
    }
  })
})

test("POST /api/search creates a task that list, get, and health can observe", async () => {
  await withHandler(async (handler) => {
    const created = await handler(
      new Request("http://127.0.0.1/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "転生したら剣でした", type: "novel" }),
      }),
    )
    assert.equal(created.status, 202)
    const createdBody = (await readJson(created)) as { error?: string; note?: string }
    assert.equal(createdBody.error, "等待超时")
    assert.match(createdBody.note ?? "", /GET \/api\/search\/:id/)

    const list = await handler(new Request("http://127.0.0.1/api/search"))
    assert.equal(list.status, 200)
    const listBody = (await readJson(list)) as {
      tasks: Array<{ id: string; query: string; type: string; status: string }>
    }
    assert.equal(listBody.tasks.length, 1)
    const summary = listBody.tasks[0]
    assert.ok(summary)
    assert.equal(summary.query, "転生したら剣でした")
    assert.equal(summary.type, "novel")
    assert.equal(summary.status, "queued")
    assert.ok(summary.id)

    const byId = await handler(new Request(`http://127.0.0.1/api/search/${summary.id}`))
    assert.equal(byId.status, 200)
    const task = (await readJson(byId)) as {
      id: string
      query: string
      type: string
      status: string
      progress: unknown[]
    }
    assert.equal(task.id, summary.id)
    assert.equal(task.query, "転生したら剣でした")
    assert.equal(task.type, "novel")
    assert.equal(task.status, "queued")
    assert.deepEqual(task.progress, [])

    const missing = await handler(new Request("http://127.0.0.1/api/search/no-such-id"))
    assert.equal(missing.status, 404)
    const missingBody = (await readJson(missing)) as { error?: string }
    assert.equal(missingBody.error, "任务不存在")

    const health = await handler(new Request("http://127.0.0.1/api/health"))
    assert.equal(health.status, 200)
    const info = (await readJson(health)) as {
      status: string
      service: string
      version: string
      opencode: { url: string; healthy: boolean; version?: string }
      runner: { limit: number; queued: number; running: number }
      tasks: { total: number; queued: number; running: number }
      time: string
    }
    assert.equal(info.status, "ok")
    assert.equal(info.service, "search-agent")
    assert.ok(info.version)
    assert.equal(info.opencode.url, "http://127.0.0.1:9")
    assert.equal(info.opencode.healthy, true)
    assert.equal(info.opencode.version, "test-opencode")
    assert.equal(info.runner.limit, 3)
    assert.equal(info.runner.queued, 1)
    assert.equal(info.tasks.total, 1)
    assert.equal(info.tasks.queued, 1)
    assert.ok(info.time)
  })
})

test("POST /api/search defaults omitted type to unknown", async () => {
  await withHandler(async (handler) => {
    const created = await handler(
      new Request("http://127.0.0.1/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "unknown-work" }),
      }),
    )
    assert.equal(created.status, 202)
    const list = await handler(new Request("http://127.0.0.1/api/search"))
    const listBody = (await readJson(list)) as { tasks: Array<{ type: string; query: string }> }
    assert.equal(listBody.tasks[0]?.query, "unknown-work")
    assert.equal(listBody.tasks[0]?.type, "unknown")
  })
})
