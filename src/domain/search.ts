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
export const BranchStatus = Schema.Literals(["confirmed", "not_found", "unknown"])
export type BranchStatus = Schema.Schema.Type<typeof BranchStatus>

export const Translation = Schema.Struct({
  group: Schema.optional(Schema.String),
  status: Schema.Literals(["ongoing", "completed", "dropped", "unknown"]),
  progress: Schema.optional(Schema.String),
  source_url: Schema.optional(Schema.NonEmptyString),
  note: Schema.optional(Schema.String),
})

export const SourceKind = Schema.Literals(["official", "fan-translation", "database", "forum", "other"])
export const SourceClaim = Schema.Literals(["identity", "official", "fan", "progress"])

export const Source = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.NonEmptyString,
  site: Schema.optional(Schema.String),
  kind: SourceKind,
  supports: Schema.Array(SourceClaim),
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
    status: BranchStatus,
    publisher: Schema.optional(Schema.String),
    regions: Schema.optional(Schema.Array(Schema.String)),
    evidence: Schema.optional(Schema.String),
  }),
  fan: Schema.Struct({
    status: BranchStatus,
    translations: Schema.Array(Translation),
  }),
  sources: Schema.Array(Source),
  summary: Schema.String,
})

export type SearchResult = Schema.Schema.Type<typeof SearchResult>

/** Confirmed branches determine the public verdict; unknown must not collapse to none. */
export function reconcileVerdict(result: SearchResult): SearchResult {
  const official = result.official.status === "confirmed"
  const fan = result.fan.status === "confirmed"
  const verdict: SearchResult["verdict"] = official
    ? (fan ? "both" : "official")
    : fan
      ? "fan"
      : result.official.status === "not_found" && result.fan.status === "not_found"
        ? "none"
        : "uncertain"
  return result.verdict === verdict ? result : { ...result, verdict }
}

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

// ── OpenCode 原始链路(只落库,不进 HTTP Task)─────────────────
// progress 是给客户端的中文摘要;opencode_trace 是同一次检索的原始 RPC + SSE。

export const OpencodeTraceCallMethod = Schema.Literals([
  "session.create",
  "session.promptAsync",
  "session.abort",
  "session.messages",
])
export type OpencodeTraceCallMethod = Schema.Schema.Type<typeof OpencodeTraceCallMethod>

export const OpencodeTraceCall = Schema.Struct({
  kind: Schema.Literal("call"),
  ts: Schema.Number,
  method: OpencodeTraceCallMethod,
  durationMs: Schema.Number,
  request: Schema.optional(Schema.Unknown),
  response: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
})

export const OpencodeTraceEventStep = Schema.Struct({
  kind: Schema.Literal("event"),
  ts: Schema.Number,
  type: Schema.String,
  properties: Schema.Unknown,
})

export const OpencodeTraceStep = Schema.Union([OpencodeTraceCall, OpencodeTraceEventStep])
export type OpencodeTraceStep = Schema.Schema.Type<typeof OpencodeTraceStep>

export const OpencodeTrace = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  steps: Schema.Array(OpencodeTraceStep),
})
export type OpencodeTrace = Schema.Schema.Type<typeof OpencodeTrace>

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
// 内嵌到用户消息中的 JSON Schema(最后一条回复必须符合)。
// 只用 type/properties/required/enum/items/description,避免 anyOf、minLength:
// opencode 读回 session 消息时会按封闭 JsonSchema 解码,多字段会 400。
// ─────────────────────────────────────────────────────────────

export const searchResultJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "work", "official", "fan", "sources", "summary"],
  properties: {
    verdict: {
      type: "string",
      enum: ["official", "fan", "both", "none", "uncertain"],
      description: "official=已确认官方中文;fan=已确认民间汉化;both=两者都已确认;none=本次检索范围内未发现;uncertain=两类都无法确认。official.status 或 fan.status 为 confirmed 时必须分别填 official、fan 或 both。",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    work: {
      type: "object",
      additionalProperties: false,
      required: ["original_title", "type"],
      properties: {
        original_title: { type: "string", description: "作品原名或通用名" },
        chinese_title: { type: "string", description: "中文译名,没有则省略" },
        author: { type: "string", description: "作者,未知则省略" },
        type: { type: "string", enum: ["novel", "manga", "other"] },
      },
    },
    official: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["confirmed", "not_found", "unknown"], description: "confirmed=已确认存在;not_found=本次未发现;unknown=尚未确认或检索受阻。confirmed 时 sources 至少一条真实 URL" },
        publisher: { type: "string" },
        regions: { type: "array", items: { type: "string" } },
        evidence: { type: "string" },
      },
    },
    fan: {
      type: "object",
      additionalProperties: false,
      required: ["status", "translations"],
      properties: {
        status: { type: "string", enum: ["confirmed", "not_found", "unknown"], description: "confirmed=已确认存在;not_found=本次未发现;unknown=尚未确认或检索受阻。confirmed 时 sources 至少一条真实检索/抓取过的 URL;禁止编造链接" },
        translations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: {
              group: { type: "string" },
              status: { type: "string", enum: ["ongoing", "completed", "dropped", "unknown"] },
              progress: { type: "string" },
              source_url: { type: "string", description: "仅填真实检索/抓取过的 URL;没有可核查链接则省略本字段,禁止编造" },
              note: { type: "string" },
            },
          },
        },
      },
    },
    sources: {
      type: "array",
      description: "可核查来源。每条须声明 supports 所支持的事实;kind 不能冒充支持关系。official.status 或 fan.status 为 confirmed 时，sources 中须有对应 official 或 fan 主张的真实 URL;禁止编造",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "kind", "supports"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          site: { type: "string" },
          kind: {
            type: "string",
            enum: ["official", "fan-translation", "database", "forum", "other"],
          },
          supports: {
            type: "array",
            description: "本页支持的事实。identity=作品身份;official=官方中文;fan=民间汉化;progress=翻译进度。同一来源可支持多项;官方来源不能自动证明民间",
            items: { type: "string", enum: ["identity", "official", "fan", "progress"] },
          },
        },
      },
    },
    summary: { type: "string", description: "中文简述:作品身份、官方中文、民间汉化、关键依据" },
  },
}
