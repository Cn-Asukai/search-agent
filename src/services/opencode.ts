import { Context, Effect, Layer } from "effect"
import {
  createOpencodeClient,
  createOpencodeServer,
  type AssistantMessage,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import { AppConfig } from "../env.js"
import { SearchResult, type SearchRequest } from "../domain/search.js"
import { searchResultJsonSchema } from "../domain/search.js"

// ─────────────────────────────────────────────────────────────
// OpenCode 服务:封装 @opencode-ai/sdk 客户端
//  仅内嵌:自动 spawn `opencode serve`(要求 opencode CLI 在 PATH 中)
//  promptAsync 异步提交(避免同步长连接被超时掐断)
// ─────────────────────────────────────────────────────────────

export class OpenCode extends Context.Service<OpenCode, {
  readonly client: OpencodeClient
  readonly url: string
  readonly close: () => void
}>()("OpenCode") {}

export const OpenCodeLive: Layer.Layer<OpenCode, Error, AppConfig> = Layer.effect(
  OpenCode
)(Effect.gen(function* () {
  const config = yield* AppConfig
  return yield* Effect.tryPromise(() =>
    createOpencodeServer({ hostname: config.opencodeHostname, port: config.opencodePort, timeout: 60_000 }),
  ).pipe(
    Effect.mapError((err) => new Error(hintEmbeddedError(err))),
    Effect.map((server) => {
      const client = createOpencodeClient({ baseUrl: server.url })
      return { client, url: server.url, close: () => server.close() }
    }),
  )
}))

function hintEmbeddedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/ENOENT|not found|spawn/i.test(message)) {
    return `未找到 opencode CLI。请先安装:npm install -g opencode-ai(或参考 https://opencode.ai/docs/ 安装)。原始错误:${message}`
  }
  if (/exited with code/i.test(message)) {
    return (
      `opencode serve 启动即退出。常见原因:` +
      `① OPENCODE_PORT 端口被占用(设为 0 可随机分配);` +
      `② 首次启动时全局 npm 插件安装失败,可先在终端运行 \`opencode serve\` 预热后重试。原始错误:${message}`
    )
  }
  return `opencode 启动失败:${message}`
}

// ─────────────────────────────────────────────────────────────
// 业务操作
// ─────────────────────────────────────────────────────────────

export class OpenCodeOps extends Context.Service<OpenCodeOps, {
  readonly createSession: Effect.Effect<string, Error>
  readonly submitSearch: (sessionID: string, request: SearchRequest) => Effect.Effect<void, Error>
  readonly getLatestAssistant: (
    sessionID: string,
  ) => Effect.Effect<{ readonly info: AssistantMessage; readonly parts: readonly unknown[] }, Error>
  readonly abortSession: (sessionID: string) => Effect.Effect<void>
  readonly health: Effect.Effect<{ ok: boolean; version?: string }>
}>()("OpenCodeOps") {}

export type OpenCodeOpsService = Context.Service.Shape<typeof OpenCodeOps>

export interface OpenCodeOpsConfig {
  readonly opencodeModel: string | undefined
  readonly opencodeAgent: string
}

/** RPC 实现。Layer 只负责取出 client / 配置;测试可传入假 client。 */
export function makeOpenCodeOps(input: {
  readonly client: OpencodeClient
  readonly config: OpenCodeOpsConfig
}): OpenCodeOpsService {
  const { client, config } = input

  const modelParam = (): { model?: { providerID: string; modelID: string } } => {
    const model = config.opencodeModel
    if (!model) return {}
    const i = model.indexOf("/")
    if (i <= 0 || i === model.length - 1) return {}
    return { model: { providerID: model.slice(0, i), modelID: model.slice(i + 1) } }
  }

  const createSession = Effect.tryPromise(() =>
    client.session.create({ title: `汉化检索 ${new Date().toISOString()}` }),
  ).pipe(
    Effect.flatMap((res) =>
      res.error || !res.data?.id
        ? Effect.fail(new Error(`创建 opencode 会话失败:${JSON.stringify(res.error)}`))
        : Effect.succeed(res.data.id),
    ),
  )

  const submitSearch = (sessionID: string, request: SearchRequest) =>
    Effect.tryPromise(() =>
      client.session.promptAsync({
        sessionID,
        agent: config.opencodeAgent,
        ...modelParam(),
        parts: [
          {
            type: "text" as const,
            text: buildUserMessage(request.query, request.type),
          },
        ],
        // 不传 format:json_schema 会强制 toolChoice=required(DeepSeek thinking 400);
        // {type:"text"} 写进 session 后 messages API 反序列化失败(Expected OutputFormatText)。
      }),
    ).pipe(
      Effect.flatMap((res) =>
        res.error
          ? Effect.fail(new Error(`opencode prompt 提交失败:${JSON.stringify(res.error)}`))
          : Effect.succeed(void 0),
      ),
    )

  const getLatestAssistant = (sessionID: string) =>
    Effect.tryPromise(() => client.session.messages({ sessionID, limit: 10 })).pipe(
      Effect.flatMap((res) => {
        if (res.error || !res.data) {
          return Effect.fail(new Error(`拉取会话消息失败:${JSON.stringify(res.error)}`))
        }
        const assistant = [...res.data].reverse().find(
          (m) => m.info?.role === "assistant" && !m.info.summary,
        )
        if (!assistant) return Effect.fail(new Error("未找到模型回复"))
        return Effect.succeed({
          info: assistant.info as AssistantMessage,
          parts: assistant.parts ?? [],
        })
      }),
    )

  const abortSession = (sessionID: string) =>
    Effect.tryPromise(() => client.session.abort({ sessionID })).pipe(
      Effect.mapError((err) => new Error(`中止会话失败:${err instanceof Error ? err.message : String(err)}`)),
      Effect.orDie,
      Effect.ignore,
    )

  const health = Effect.tryPromise(() => client.global.health()).pipe(
    Effect.map((res) =>
      res.error
        ? { ok: false }
        : {
            ok: true,
            version: (res.data as { version?: string } | undefined)?.version,
          },
    ),
    Effect.catch(() => Effect.succeed({ ok: false })),
  )

  return {
    createSession,
    submitSearch,
    getLatestAssistant,
    abortSession,
    health,
  }
}

export const OpenCodeOpsLive: Layer.Layer<OpenCodeOps, never, OpenCode | AppConfig> = Layer.effect(
  OpenCodeOps,
)(
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const config = yield* AppConfig
    return makeOpenCodeOps({
      client: opencode.client,
      config: {
        opencodeModel: config.opencodeModel,
        opencodeAgent: config.opencodeAgent,
      },
    })
  }),
)

// ─────────────────────────────────────────────────────────────
// 消息构造
// ─────────────────────────────────────────────────────────────

function buildUserMessage(query: string, type: SearchRequest["type"]): string {
  const labels: Record<SearchRequest["type"], string> = {
    novel: "轻小说",
    manga: "漫画",
    unknown: "未指定(轻小说/漫画均需排查)",
  }
  return [
    "请检索以下作品的汉化信息:",
    "",
    `作品名/描述:${query}`,
    `类型:${labels[type]}`,
    "",
    "按系统提示词中的检索流程执行。全部检索完成后,最后一条回复必须是一个 JSON 对象(可放在 ```json 代码块中),不要在 JSON 之外写结论。JSON 必须符合下列 Schema:",
    JSON.stringify(searchResultJsonSchema),
  ].join("\n")
}

// ─────────────────────────────────────────────────────────────
// 错误解读(模型层错误 → 中文提示)
// ─────────────────────────────────────────────────────────────

export function describeMessageError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; message?: unknown; data?: { message?: unknown; statusCode?: unknown } }
    const name = typeof e.name === "string" ? e.name : "Error"
    const data = e.data
    const detail =
      typeof e.message === "string" && e.message
        ? e.message
        : typeof data?.message === "string" && data.message
          ? data.message
          : ""
    const statusCode = typeof data?.statusCode === "number" ? ` (HTTP ${data.statusCode})` : ""
    if (name === "ProviderAuthError") {
      return `模型 provider 鉴权失败,请运行 \`opencode auth login\` 配置 API key${detail ? `:${detail}` : ""}`
    }
    if (name === "StructuredOutputError") {
      return `结构化输出失败(模型可能不支持或结果不符合 Schema)${detail ? `:${detail}` : ""}`
    }
    if (name === "MessageAbortedError") return "会话被中止"
    if (name === "APIError" || name === "ApiError") {
      return `模型 API 调用失败${statusCode}${detail ? `:${detail}` : "(请检查模型 API key、额度与网络)"}`
    }
    return `模型调用出错:${name}${detail ? `:${detail}` : ""}`
  }
  return `模型调用出错:${String(err)}`
}

// ─────────────────────────────────────────────────────────────
// 结果解析:结构化输出优先,Schema 校验,兜底文本 JSON
// ─────────────────────────────────────────────────────────────

import { Schema } from "effect"

export function parseStructuredResult(raw: unknown): SearchResult | null {
  if (raw == null || typeof raw !== "object") return null
  const cleaned = stripNulls(raw)
  if (cleaned == null || typeof cleaned !== "object") return null
  const candidates = [
    cleaned,
    ...unwrapKeys(cleaned, ["output", "data", "result", "structured", "structured_output"]),
  ]
  for (const candidate of candidates) {
    const decoded = Schema.decodeUnknownOption(SearchResult)(candidate)
    if (decoded._tag === "Some") return decoded.value
  }
  return null
}

export function parseFromTextParts(parts: readonly unknown[]): SearchResult | null {
  const text = parts
    .filter((p): p is { type: string; text?: string } => typeof p === "object" && p !== null && "type" in (p as object))
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
  if (!text.trim()) return null

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates: string[] = []
  if (fenced?.[1]) candidates.push(fenced[1])
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const parsed = parseStructuredResult(JSON.parse(candidate))
      if (parsed) return parsed
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

/** 从 assistant 消息 / 工具入参 / 文本里取出第一条能过 Schema 的结论 */
export function resolveSearchResult(input: {
  readonly info?: AssistantMessage
  readonly structuredFromTool?: unknown
  readonly parts?: readonly unknown[]
}): SearchResult | null {
  const rec = input.info as unknown as Record<string, unknown> | undefined
  const candidates: unknown[] = [
    input.info?.structured,
    rec?.structured_output,
    input.structuredFromTool,
  ]
  for (const candidate of candidates) {
    const parsed = parseStructuredResult(candidate)
    if (parsed) return parsed
  }
  if (input.parts?.length) return parseFromTextParts(input.parts)
  return null
}

/** JSON Schema 把 optional 编成 string | null;Effect optional 不接受 null,解码前先丢掉 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === null) continue
      out[key] = stripNulls(child)
    }
    return out
  }
  return value
}

function unwrapKeys(obj: object, keys: string[]): unknown[] {
  const result: unknown[] = []
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key]
    if (value != null && typeof value === "object") result.push(value)
  }
  return result
}
