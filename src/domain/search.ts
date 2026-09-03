import { Schema } from "effect"

// ─────────────────────────────────────────────────────────────
// 领域 Schema:请求、结果、进度、任务(替代原 zod 定义)
// 注意:Schema 只做结构校验;可选字段用 Schema.optional,
// 默认值在服务/路由层处理(rc 版 Schema.Struct 字段默认值有 bug)
// ─────────────────────────────────────────────────────────────

// ── 请求 ─────────────────────────────────────────────────────

export const WorkType = Schema.Literals(["novel", "manga", "unknown"])
export type WorkType = Schema.Schema.Type<typeof WorkType>

export const SearchRequest = Schema.Struct({
  /** 作品名或描述(可含作者、别名等线索) */
  query: Schema.NonEmptyString,
  /** 作品类型(缺省 unknown) */
  type: WorkType,
  /** true 时返回 SSE 流(进度 + 结果),false 时阻塞返回 JSON */
  stream: Schema.Boolean,
})

export type SearchRequest = Schema.Schema.Type<typeof SearchRequest>

export const workTypeLabels: Record<WorkType, string> = {
  novel: "轻小说",
  manga: "漫画",
  unknown: "未指定(轻小说/漫画均需排查)",
}

// ── 检索结果 ─────────────────────────────────────────────────

export const Verdict = Schema.Literals(["official", "fan", "both", "none", "uncertain"])
export const Confidence = Schema.Literals(["high", "medium", "low"])

export const Translation = Schema.Struct({
  group: Schema.optional(Schema.String),
  status: Schema.Literals(["ongoing", "completed", "dropped", "unknown"]),
  progress: Schema.optional(Schema.String),
  source_url: Schema.NonEmptyString,
  note: Schema.optional(Schema.String),
})

export const SourceKind = Schema.Literals(["official", "fan-translation", "database", "forum", "other"])

export const Source = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.NonEmptyString,
  site: Schema.optional(Schema.String),
  kind: SourceKind,
})

export const SearchResult = Schema.Struct({
  verdict: Verdict,
  confidence: Confidence,
  work: Schema.Struct({
    original_title: Schema.NonEmptyString,
    chinese_title: Schema.optional(Schema.String),
    author: Schema.optional(Schema.String),
    type: Schema.Literals(["novel", "manga", "other"]),
  }),
  official: Schema.Struct({
    exists: Schema.Boolean,
    publisher: Schema.optional(Schema.String),
    regions: Schema.optional(Schema.Array(Schema.String)),
    evidence: Schema.optional(Schema.String),
  }),
  fan: Schema.Struct({
    exists: Schema.Boolean,
    translations: Schema.Array(Translation),
  }),
  sources: Schema.Array(Source),
  summary: Schema.String,
})

export type SearchResult = Schema.Schema.Type<typeof SearchResult>

// ── 任务与进度 ───────────────────────────────────────────────

export const TaskStatus = Schema.Literals(["queued", "running", "done", "error"])

export const ProgressEntry = Schema.Struct({
  seq: Schema.Number,
  ts: Schema.Number,
  /** status=阶段状态;tool=工具调用 */
  kind: Schema.Literals(["status", "tool", "text"]),
  message: Schema.String,
  tool: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literals(["running", "completed", "error"])),
  detail: Schema.optional(Schema.String),
})

export type ProgressEntry = Schema.Schema.Type<typeof ProgressEntry>

export const Task = Schema.Struct({
  id: Schema.NonEmptyString,
  query: Schema.NonEmptyString,
  type: WorkType,
  status: TaskStatus,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  endedAt: Schema.optional(Schema.Number),
  sessionId: Schema.optional(Schema.String),
  progress: Schema.Array(ProgressEntry),
  result: Schema.optional(SearchResult),
  error: Schema.optional(Schema.String),
})

export type Task = Schema.Schema.Type<typeof Task>

/** 任务事件(进度 / 终态),用于 PubSub 广播 */
export type TaskEvent =
  | { readonly _tag: "progress"; readonly task: Task; readonly entry: ProgressEntry }
  | { readonly _tag: "done"; readonly task: Task }
  | { readonly _tag: "error"; readonly task: Task }

// ── SSE 事件(对外)───────────────────────────────────────────

export type SseClientEvent =
  | { readonly event: "task"; readonly data: unknown }
  | { readonly event: "progress"; readonly data: unknown }
  | { readonly event: "result"; readonly data: unknown }
  | { readonly event: "error"; readonly data: unknown }
  | { readonly event: "ping"; readonly data: unknown }

// ─────────────────────────────────────────────────────────────
// 供 opencode 结构化输出(format=json_schema)使用的 JSON Schema
// (draft-2020-12,由 effect Schema 编译而来)
// ─────────────────────────────────────────────────────────────

export const searchResultJsonSchema = Schema.toJsonSchemaDocument(SearchResult)
