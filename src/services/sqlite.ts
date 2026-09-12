import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { AppConfig } from "../env.js"

// ─────────────────────────────────────────────────────────────
// SQLite:打开文件(WAL) + 建表。
// tasks 上一行两个 JSON 列职责不同:
//   progress_json  → HTTP/SSE 的 Task.progress(中文阶段/工具摘要)
//   opencode_trace → 原始 opencode RPC + SSE,不进 HTTP
// ─────────────────────────────────────────────────────────────

const SqliteClientLive: Layer.Layer<SqliteClient.SqliteClient | SqlClient.SqlClient, never, AppConfig> =
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig
      ensureSqliteDir(config.sqlitePath)
      return SqliteClient.layer({ filename: config.sqlitePath })
    }),
  )

const MigratorLive = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_init": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          session_id TEXT,
          progress_json TEXT NOT NULL DEFAULT '[]',
          result_json TEXT,
          error TEXT,
          opencode_trace TEXT
        )
      `
      yield* sql`CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC)`
      yield* sql`CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)`
      yield* sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`
    }),
    "0002_work_facts": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE IF NOT EXISTS works (
          id TEXT PRIMARY KEY,
          original_title TEXT NOT NULL,
          author TEXT,
          type TEXT NOT NULL,
          official_json TEXT NOT NULL,
          fan_json TEXT NOT NULL,
          checked_at INTEGER NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE IF NOT EXISTS work_aliases (
          alias TEXT NOT NULL,
          type TEXT NOT NULL,
          work_id TEXT NOT NULL,
          source TEXT NOT NULL,
          PRIMARY KEY(alias, type)
        )
      `
    }),
  }),
})

export const SqliteLive: Layer.Layer<
  SqliteClient.SqliteClient | SqlClient.SqlClient,
  SqliteMigrator.MigrationError | SqlError,
  AppConfig
> = MigratorLive.pipe(Layer.provideMerge(SqliteClientLive))

export const STALE_TASK_ERROR = "服务重启，任务中断"

function ensureSqliteDir(filename: string): void {
  if (filename === ":memory:" || filename.startsWith("file:")) return
  mkdirSync(dirname(filename), { recursive: true })
}
