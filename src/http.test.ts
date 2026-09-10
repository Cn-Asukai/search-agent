import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Duration, Effect, Layer, PubSub, Redacted } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { AppConfig } from "./env.js"
import { RoutesLayer } from "./http.js"
import { eventLoop, type OpencodeEvent } from "./services/eventBridge.js"
import { OpenCode, OpenCodeOps } from "./services/opencode.js"
import { SearchRunner } from "./services/searchRunner.js"
import { SqliteLive } from "./services/sqlite.js"
import { TaskManager, TaskManagerLive } from "./services/taskManager.js"

function configLive(opts?: { apiAuthKey?: string; syncMaxWaitMs?: number }) {
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
      syncMaxWait: Duration.millis(opts?.syncMaxWaitMs ?? 80),
      apiAuthKey: opts?.apiAuthKey ? Redacted.make(opts.apiAuthKey) : undefined,
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

function openCodeOpsTest(aborted?: string[]) {
  return Layer.succeed(
    OpenCodeOps,
    OpenCodeOps.of({
      createSession: Effect.succeed("ses_http"),
      submitSearch: () => Effect.void,
      getLatestAssistant: () => Effect.fail(new Error("未找到模型回复")),
      abortSession: (sessionID: string) =>
        Effect.sync(() => {
          aborted?.push(sessionID)
        }),
      health: Effect.succeed({ ok: true, version: "test-opencode" }),
    }),
  )
}

const IdleRunner = Layer.succeed(
  SearchRunner,
  SearchRunner.of({
    launch: () => Effect.void,
  }),
)

const FailNowRunner = Layer.effect(SearchRunner)(
  Effect.gen(function* () {
    const tasks = yield* TaskManager
    return SearchRunner.of({
      launch: (id) => tasks.update(id, { status: "error", error: "boom", endedAt: Date.now() }),
    })
  }),
)

const FailSoonRunner = Layer.effect(SearchRunner)(
  Effect.gen(function* () {
    const tasks = yield* TaskManager
    return SearchRunner.of({
      launch: (id) =>
        Effect.forkDetach(
          Effect.sleep(Duration.millis(20)).pipe(
            Effect.andThen(tasks.update(id, { status: "error", error: "fast-fail", endedAt: Date.now() })),
          ),
        ).pipe(Effect.as(undefined as void)),
    })
  }),
)

const RunningRunner = Layer.effect(SearchRunner)(
  Effect.gen(function* () {
    const tasks = yield* TaskManager
    return SearchRunner.of({
      launch: (id) => tasks.update(id, { status: "running", sessionId: "sess-1", startedAt: Date.now() }),
    })
  }),
)

function servicesLayer(opts?: {
  apiAuthKey?: string
  syncMaxWaitMs?: number
  runner?: Layer.Layer<SearchRunner, never, TaskManager>
  aborted?: string[]
}) {
  const config = configLive(opts)
  const tasks = TaskManagerLive.pipe(Layer.provideMerge(SqliteLive), Layer.provide(config))
  const runner = (opts?.runner ?? IdleRunner).pipe(Layer.provide(tasks))
  return Layer.mergeAll(runner, tasks, OpenCodeTest, openCodeOpsTest(opts?.aborted), config)
}

async function withHandler<A>(
  use: (handler: (request: Request) => Promise<Response>) => Promise<A>,
  opts?: {
    apiAuthKey?: string
    syncMaxWaitMs?: number
    runner?: Layer.Layer<SearchRunner, never, TaskManager>
    aborted?: string[]
  },
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = createServer()
        const ctx = yield* Layer.build(servicesLayer(opts))
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
    const createdBody = (await readJson(created)) as { id?: string; status?: string; error?: string; note?: string }
    assert.ok(createdBody.id)
    assert.equal(createdBody.status, "queued")
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
    assert.equal(summary.id, createdBody.id)

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

test("未配置 apiAuthKey 时可匿名访问受保护接口", async () => {
  await withHandler(async (handler) => {
    const res = await handler(new Request("http://127.0.0.1/api/search"))
    assert.equal(res.status, 200)
  })
})

test("配置 apiAuthKey 后缺/错 Bearer 返回 401,对的通过,health 无密钥也能过", async () => {
  await withHandler(
    async (handler) => {
      const health = await handler(new Request("http://127.0.0.1/api/health"))
      assert.equal(health.status, 200)

      const missing = await handler(new Request("http://127.0.0.1/api/search"))
      assert.equal(missing.status, 401)
      assert.deepEqual(await readJson(missing), { error: "未授权" })

      const wrong = await handler(
        new Request("http://127.0.0.1/api/search", { headers: { authorization: "Bearer nope" } }),
      )
      assert.equal(wrong.status, 401)
      assert.deepEqual(await readJson(wrong), { error: "未授权" })

      const ok = await handler(
        new Request("http://127.0.0.1/api/search", { headers: { authorization: "Bearer secret" } }),
      )
      assert.equal(ok.status, 200)
    },
    { apiAuthKey: "secret" },
  )
})

test("快失败走快照,不等满 SYNC_MAX_WAIT,error 不是 500", async () => {
  await withHandler(
    async (handler) => {
      const started = Date.now()
      const res = await handler(
        new Request("http://127.0.0.1/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "boom-work" }),
        }),
      )
      const elapsed = Date.now() - started
      assert.notEqual(res.status, 500)
      assert.equal(res.status, 200)
      const body = (await readJson(res)) as { status?: string; error?: string }
      assert.equal(body.status, "error")
      assert.equal(body.error, "boom")
      assert.ok(elapsed < 1000, `快失败不应等满 SYNC_MAX_WAIT, elapsed=${elapsed}`)
    },
    { syncMaxWaitMs: 30_000, runner: FailNowRunner },
  )
})

test("快失败走 live 事件,error 不是 500", async () => {
  await withHandler(
    async (handler) => {
      const started = Date.now()
      const res = await handler(
        new Request("http://127.0.0.1/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "live-fail" }),
        }),
      )
      const elapsed = Date.now() - started
      assert.notEqual(res.status, 500)
      assert.equal(res.status, 200)
      const body = (await readJson(res)) as { status?: string; error?: string }
      assert.equal(body.status, "error")
      assert.equal(body.error, "fast-fail")
      assert.ok(elapsed < 1000, `live 快失败不应等满 SYNC_MAX_WAIT, elapsed=${elapsed}`)
    },
    { syncMaxWaitMs: 30_000, runner: FailSoonRunner },
  )
})

test("POST abort:不存在 404,已终态幂等 200,queued/running 取消", async () => {
  const aborted: string[] = []
  await withHandler(
    async (handler) => {
      const missing = await handler(new Request("http://127.0.0.1/api/search/nope/abort", { method: "POST" }))
      assert.equal(missing.status, 404)

      const created = await handler(
        new Request("http://127.0.0.1/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "to-abort" }),
        }),
      )
      assert.equal(created.status, 202)
      const createdBody = (await readJson(created)) as { id: string }
      const cancelled = await handler(
        new Request(`http://127.0.0.1/api/search/${createdBody.id}/abort`, { method: "POST" }),
      )
      assert.equal(cancelled.status, 200)
      const cancelledBody = (await readJson(cancelled)) as { status?: string; error?: string }
      assert.equal(cancelledBody.status, "error")
      assert.equal(cancelledBody.error, "已取消")
      assert.deepEqual(aborted, ["sess-1"])

      const again = await handler(
        new Request(`http://127.0.0.1/api/search/${createdBody.id}/abort`, { method: "POST" }),
      )
      assert.equal(again.status, 200)
      assert.deepEqual(aborted, ["sess-1"])
    },
    { runner: RunningRunner, aborted },
  )
})

test("abort 走同一 Bearer 中间件,health 除外", async () => {
  await withHandler(
    async (handler) => {
      const denied = await handler(new Request("http://127.0.0.1/api/search/x/abort", { method: "POST" }))
      assert.equal(denied.status, 401)
      const health = await handler(new Request("http://127.0.0.1/api/health"))
      assert.equal(health.status, 200)
    },
    { apiAuthKey: "secret" },
  )
})

test("eventLoop 在 subscribe 成功后才完成 ready", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let subscribeCalls = 0
  const client = {
    event: {
      subscribe: async () => {
        subscribeCalls += 1
        await gate
        return { stream: (async function* () {})() }
      },
    },
  } as unknown as OpencodeClient

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OpencodeEvent>()
        const ready = yield* Deferred.make<void>()
        yield* eventLoop(client, events, ready).pipe(Effect.forkScoped)
        yield* Effect.sleep(Duration.millis(30))
        assert.equal(yield* Deferred.isDone(ready), false)
        release()
        yield* Deferred.await(ready)
        assert.equal(subscribeCalls, 1)
      }),
    ),
  )
})
