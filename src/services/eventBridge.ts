import { Context, Effect, Layer, PubSub, type Scope } from "effect"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

// ─────────────────────────────────────────────────────────────
// opencode 事件桥:订阅一次全局 SSE,按 sessionID 分发到
// PubSub,供任务等待终态 / 进度翻译使用。断线自动重连。
// ─────────────────────────────────────────────────────────────

export interface OpencodeEvent {
  readonly type: string
  readonly properties: {
    readonly sessionID?: string
    readonly info?: unknown
    readonly part?: unknown
    readonly [key: string]: unknown
  }
}

// ─────────────────────────────────────────────────────────────
// 工具调用事件 → 中文进度条目
// ─────────────────────────────────────────────────────────────

/** 已知工具的中文描述;按子串匹配以兼容 MCP 前缀(如 websearch_smartsearch) */
const TOOL_LABELS: [substring: string, label: string][] = [
  ["smartsearch", "联网搜索"],
  ["academicsearch", "学术检索"],
  ["cleanfetch", "读取网页"],
  ["webfetch", "读取网页"],
  ["structuredoutput", "生成结构化结论"],
  ["read", "读取文件"],
  ["grep", "检索文件"],
]

function toolLabel(tool: string): string {
  const lower = tool.toLowerCase()
  for (const [substring, label] of TOOL_LABELS) {
    if (lower.includes(substring)) return label
  }
  return "调用工具"
}

/** 从工具入参里提取一个可读摘要(搜索词 / URL 等) */
function inputDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  const preferred = ["query", "q", "keywords", "keyword", "url", "search", "prompt"]
  for (const key of preferred) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return truncate(value, 200)
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) return truncate(value, 200)
  }
  return undefined
}

export interface ProgressEntryLike {
  kind: "status" | "tool" | "text"
  message: string
  tool?: string
  state?: "running" | "completed" | "error"
  detail?: string
}

/** 把 message.part.updated 事件(工具调用)翻译成进度条目 */
export function describePartEvent(event: OpencodeEvent): Omit<ProgressEntryLike, "seq" | "ts"> | null {
  const part = event.properties?.part as
    | { type?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } }
    | undefined
  if (!part || part.type !== "tool" || !part.tool) return null
  const status = part.state?.status
  if (status !== "running" && status !== "completed" && status !== "error") return null

  const label = toolLabel(part.tool)
  const skipDetail = part.tool.toLowerCase().includes("structuredoutput")
  const detail = skipDetail ? undefined : inputDetail(part.state?.input)
  let message: string
  switch (status) {
    case "running":
      message = detail ? `正在${label}:${detail}` : `正在${label}`
      break
    case "completed":
      message = detail ? `${label}完成:${detail}` : `${label}完成`
      break
    default:
      message = `${label}失败${detail ? `(${detail})` : ""}`
  }
  return { kind: "tool", message, tool: part.tool, state: status, detail }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export class EventBridge extends Context.Service<EventBridge, {
  readonly events: PubSub.PubSub<OpencodeEvent>
}>()("EventBridge") {}

export const EventBridgeLive: Layer.Layer<EventBridge> = Layer.effect(
  EventBridge
)(Effect.gen(function* () {
  const events = yield* PubSub.unbounded<OpencodeEvent>()
  return { events }
}))

/**
 * 事件循环:连接 opencode 的 SSE 事件流,把每个事件发布到 PubSub。
 * 断线重连在 runNativeLoop 内完成。不能 Effect.sync + Effect.forever:
 * sync 立刻成功,forever 会每 tick 再开一条 SSE,把本机套接字打满。
 */
export function eventLoop(
  client: OpencodeClient,
  events: PubSub.PubSub<OpencodeEvent>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const ac = new AbortController()
      void runNativeLoop(client, events, ac.signal)
      return ac
    }),
    (ac) => Effect.sync(() => ac.abort()),
  ).pipe(Effect.flatMap(() => Effect.never))
}

/** 原生 async 循环:订阅 SSE 并发布到 PubSub,断线重连 */
export async function runNativeLoop(
  client: OpencodeClient,
  events: PubSub.PubSub<OpencodeEvent>,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    try {
      const subscription = await client.event.subscribe()
      for await (const event of subscription.stream) {
        if (signal?.aborted) return
        Effect.runFork(PubSub.publish(events, event as OpencodeEvent))
      }
      console.warn(`[event-bridge] 事件流结束,5s 后重连`)
    } catch (err) {
      if (signal?.aborted) return
      console.warn(`[event-bridge] 事件流异常,5s 后重连:`, err)
    }
    await delay(5000, signal)
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
