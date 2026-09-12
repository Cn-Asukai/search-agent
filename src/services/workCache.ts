import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SearchResult, WorkType } from "../domain/search.js"

// ─────────────────────────────────────────────────────────────
// 作品级身份 / 存在事实缓存。
// 已确认存在(official.exists / fan.exists,以及将来的 status=confirmed)
// 不被后来的 none/false 覆盖;未发现记录 7 天后不再命中。
// ─────────────────────────────────────────────────────────────

export const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type WorkFacts = {
  readonly id: string
  readonly original_title: string
  readonly chinese_title: string | undefined
  readonly author: string | undefined
  readonly type: string
  readonly official: SearchResult["official"]
  readonly fan: SearchResult["fan"]
  readonly checked_at: number
}

type WorkRow = {
  readonly id: string
  readonly original_title: string
  readonly author: string | null
  readonly type: string
  readonly official_json: string
  readonly fan_json: string
  readonly checked_at: number
}

type OfficialFacts = SearchResult["official"]
type FanFacts = SearchResult["fan"]

export class WorkCache extends Context.Service<WorkCache, {
  readonly put: (query: string, type: WorkType, result: SearchResult) => Effect.Effect<void>
  readonly get: (query: string, type: WorkType) => Effect.Effect<Option.Option<WorkFacts>>
}>()("WorkCache") {}

export const WorkCacheLive: Layer.Layer<WorkCache, never, SqlClient.SqlClient> = Layer.effect(
  WorkCache,
)(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const loadWork = (id: string) =>
    sql<WorkRow>`
      SELECT id, original_title, author, type, official_json, fan_json, checked_at
      FROM works WHERE id = ${id} LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]), Effect.orDie)

  const findWorkId = (query: string, type: WorkType, originalTitle: string) =>
    Effect.gen(function* () {
      const byTitle = yield* sql<WorkRow>`
        SELECT id, original_title, author, type, official_json, fan_json, checked_at
        FROM works
        WHERE original_title = ${originalTitle} AND type = ${type}
        LIMIT 1
      `.pipe(Effect.orDie)
      if (byTitle[0]) return byTitle[0].id

      const byOriginalAlias = yield* sql<{ work_id: string }>`
        SELECT work_id FROM work_aliases
        WHERE alias = ${originalTitle} AND type = ${type}
        LIMIT 1
      `.pipe(Effect.orDie)
      if (byOriginalAlias[0]) return byOriginalAlias[0].work_id

      if (query !== originalTitle) {
        const byQueryAlias = yield* sql<{ work_id: string }>`
          SELECT work_id FROM work_aliases
          WHERE alias = ${query} AND type = ${type}
          LIMIT 1
        `.pipe(Effect.orDie)
        if (byQueryAlias[0]) return byQueryAlias[0].work_id
      }
      return undefined
    })

  const writeAliases = (
    workId: string,
    type: WorkType,
    query: string,
    originalTitle: string,
    chineseTitle: string | undefined,
  ) =>
    Effect.gen(function* () {
      const aliases = pickAliases(query, originalTitle, chineseTitle)
      for (const { alias, source } of aliases) {
        yield* sql`
          INSERT INTO work_aliases (alias, type, work_id, source)
          VALUES (${alias}, ${type}, ${workId}, ${source})
          ON CONFLICT(alias, type) DO UPDATE SET
            source = excluded.source
          WHERE work_aliases.work_id = excluded.work_id
        `.pipe(Effect.orDie)
      }
    })

  const put = (query: string, type: WorkType, result: SearchResult) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const q = query.trim()
        const originalTitle = result.work.original_title.trim() || q
        if (!originalTitle) return

        const now = Date.now()
        const incomingOfficial = result.official
        const incomingFan = result.fan
        const existingId = yield* findWorkId(q, type, originalTitle)

        if (existingId) {
          const existing = yield* loadWork(existingId)
          if (!existing) return
          const official = mergeOfficial(existing.official_json, incomingOfficial)
          const fan = mergeFan(existing.fan_json, incomingFan)
          const author = nonempty(existing.author) ?? nonempty(result.work.author) ?? null
          yield* sql`
            UPDATE works SET
              author = ${author},
              official_json = ${JSON.stringify(official)},
              fan_json = ${JSON.stringify(fan)},
              checked_at = ${now}
            WHERE id = ${existingId}
          `.pipe(Effect.orDie)
          yield* writeAliases(existingId, type, q, originalTitle, nonempty(result.work.chinese_title))
          return
        }

        const id = randomUUID()
        const author = nonempty(result.work.author) ?? null
        yield* sql`
          INSERT INTO works (
            id, original_title, author, type, official_json, fan_json, checked_at
          ) VALUES (
            ${id}, ${originalTitle}, ${author}, ${type},
            ${JSON.stringify(incomingOfficial)}, ${JSON.stringify(incomingFan)}, ${now}
          )
        `.pipe(Effect.orDie)
        yield* writeAliases(id, type, q, originalTitle, nonempty(result.work.chinese_title))
      }),
    ).pipe(Effect.orDie)

  const get = (query: string, type: WorkType) =>
    Effect.gen(function* () {
      const alias = query.trim()
      if (!alias) return Option.none()
      const matched = yield* sql<{ work_id: string }>`
        SELECT work_id FROM work_aliases
        WHERE alias = ${alias} AND type = ${type}
        LIMIT 1
      `.pipe(Effect.orDie)
      const workId = matched[0]?.work_id
      if (!workId) return Option.none()
      const work = yield* loadWork(workId)
      if (!work) return Option.none()

      const official = parseOfficial(work.official_json)
      const fan = parseFan(work.fan_json)
      if (!isConfirmedExists(official) && !isConfirmedExists(fan)) {
        if (Date.now() - work.checked_at > NOT_FOUND_TTL_MS) return Option.none()
      }

      const chinese = yield* sql<{ alias: string }>`
        SELECT alias FROM work_aliases
        WHERE work_id = ${work.id} AND source = ${"chinese"}
        LIMIT 1
      `.pipe(Effect.orDie)

      return Option.some({
        id: work.id,
        original_title: work.original_title,
        chinese_title: chinese[0]?.alias,
        author: work.author ?? undefined,
        type: work.type,
        official,
        fan,
        checked_at: work.checked_at,
      } satisfies WorkFacts)
    })

  return { put, get }
}))

function nonempty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** 已确认存在:exists=true,或将来的 status=confirmed(不改当前 Schema 形状) */
function isConfirmedExists(part: { readonly exists?: boolean; readonly status?: unknown }): boolean {
  return part.exists === true || part.status === "confirmed"
}

function parseOfficial(raw: string): OfficialFacts {
  try {
    const value = JSON.parse(raw) as unknown
    if (value && typeof value === "object" && typeof (value as OfficialFacts).exists === "boolean") {
      return value as OfficialFacts
    }
  } catch {
    // 损坏的缓存按未确认处理
  }
  return { exists: false }
}

function parseFan(raw: string): FanFacts {
  try {
    const value = JSON.parse(raw) as unknown
    if (value && typeof value === "object" && typeof (value as FanFacts).exists === "boolean") {
      const translations = (value as FanFacts).translations
      return {
        exists: (value as FanFacts).exists,
        translations: Array.isArray(translations) ? translations : [],
      }
    }
  } catch {
    // 损坏的缓存按未确认处理
  }
  return { exists: false, translations: [] }
}

function mergeOfficial(oldJson: string, incoming: OfficialFacts): OfficialFacts {
  const old = parseOfficial(oldJson)
  if (isConfirmedExists(old) && !isConfirmedExists(incoming)) return old
  return incoming
}

function mergeFan(oldJson: string, incoming: FanFacts): FanFacts {
  const old = parseFan(oldJson)
  if (isConfirmedExists(old) && !isConfirmedExists(incoming)) return old
  return incoming
}

const SOURCE_RANK: Record<string, number> = { original: 0, chinese: 1, query: 2 }

function pickAliases(
  query: string,
  originalTitle: string,
  chineseTitle: string | undefined,
): readonly { alias: string; source: string }[] {
  const best = new Map<string, string>()
  const consider = (alias: string, source: string) => {
    if (!alias) return
    const prev = best.get(alias)
    const rank = SOURCE_RANK[source] ?? 99
    if (prev === undefined || rank < (SOURCE_RANK[prev] ?? 99)) best.set(alias, source)
  }
  consider(query, "query")
  consider(originalTitle, "original")
  if (chineseTitle) consider(chineseTitle, "chinese")
  return [...best].map(([alias, source]) => ({ alias, source }))
}
