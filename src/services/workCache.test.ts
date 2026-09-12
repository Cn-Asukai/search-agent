import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AppConfig } from "../env.js"
import type { SearchResult } from "../domain/search.js"
import { SqliteLive } from "./sqlite.js"
import { NOT_FOUND_TTL_MS, WorkCache, WorkCacheLive } from "./workCache.js"

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
      taskRetention: 500,
      progressRetention: 200,
      traceStepRetention: 500,
    }),
  )
}

function cacheLayer(sqlitePath: string) {
  return WorkCacheLive.pipe(Layer.provideMerge(SqliteLive), Layer.provide(configLive(sqlitePath)))
}

function run<A>(effect: Effect.Effect<A, never, WorkCache | SqlClient.SqlClient>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(cacheLayer(":memory:")))))
}

const confirmed: SearchResult = {
  verdict: "official",
  confidence: "high",
  work: {
    original_title: "転生したら剣でした",
    chinese_title: "转生成为魔剑",
    author: "田中",
    type: "novel",
  },
  official: { exists: true, publisher: "东立出版社" },
  fan: { exists: false, translations: [] },
  sources: [],
  summary: "存在官方中文",
}

const noneResult: SearchResult = {
  verdict: "none",
  confidence: "low",
  work: { original_title: "転生したら剣でした", type: "novel" },
  official: { exists: false },
  fan: { exists: false, translations: [] },
  sources: [],
  summary: "未发现",
}

test("aliases of query, original_title, and chinese_title hit the same work", async () => {
  await run(Effect.gen(function* () {
    const cache = yield* WorkCache
    yield* cache.put(" 剑 ", "novel", confirmed)

    const byQuery = yield* cache.get("剑", "novel")
    const byOriginal = yield* cache.get("転生したら剣でした", "novel")
    const byChinese = yield* cache.get("转生成为魔剑", "novel")
    assert.equal(Option.isSome(byQuery), true)
    assert.equal(Option.isSome(byOriginal), true)
    assert.equal(Option.isSome(byChinese), true)
    const work = Option.getOrThrow(byQuery)
    assert.equal(Option.getOrThrow(byOriginal).id, work.id)
    assert.equal(Option.getOrThrow(byChinese).id, work.id)
    assert.equal(work.original_title, "転生したら剣でした")
    assert.equal(work.chinese_title, "转生成为魔剑")
    assert.equal(work.official.exists, true)
  }))
})

test("confirmed existence is not overwritten by later none", async () => {
  await run(Effect.gen(function* () {
    const cache = yield* WorkCache
    yield* cache.put("剑", "novel", confirmed)
    yield* cache.put("剑", "novel", noneResult)

    const hit = yield* cache.get("剑", "novel")
    assert.equal(Option.isSome(hit), true)
    const work = Option.getOrThrow(hit)
    assert.equal(work.official.exists, true)
    assert.equal(work.official.publisher, "东立出版社")
    assert.equal(work.author, "田中")
  }))
})

test("not-found older than 7 days is ignored", async () => {
  await run(Effect.gen(function* () {
    const cache = yield* WorkCache
    const sql = yield* SqlClient.SqlClient
    yield* cache.put("无名之作", "manga", {
      verdict: "none",
      confidence: "low",
      work: { original_title: "无名之作", type: "manga" },
      official: { exists: false },
      fan: { exists: false, translations: [] },
      sources: [],
      summary: "未发现",
    })

    const fresh = yield* cache.get("无名之作", "manga")
    assert.equal(Option.isSome(fresh), true)

    const stale = Date.now() - NOT_FOUND_TTL_MS - 1_000
    yield* sql`UPDATE works SET checked_at = ${stale}`
    const expired = yield* cache.get("无名之作", "manga")
    assert.equal(Option.isNone(expired), true)
  }))
})
