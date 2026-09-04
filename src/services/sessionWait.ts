import { Duration, Effect, Stream, type PubSub } from "effect"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { OpencodeEvent } from "./eventBridge.js"
import { describeMessageError } from "./opencode.js"

// ─────────────────────────────────────────────────────────────
// 等待一次检索会话真正结束。
// opencode 在 LLM 开始前就会发出第一条 assistant 的 message.updated,
// structured 要等循环里调用 StructuredOutput 工具之后才写上。
// 因此必须等到 session.idle(或 assistant 带 error),不能在首条 assistant 上返回。
// ─────────────────────────────────────────────────────────────

export type SessionWaitResult =
  | {
      readonly ok: true
      readonly finalInfo: AssistantMessage | undefined
      readonly textParts: readonly unknown[]
      readonly structuredFromTool: unknown
    }
  | {
      readonly ok: false
      readonly error: string
      readonly finalInfo: undefined
      readonly textParts: readonly unknown[]
      readonly structuredFromTool: unknown
    }

export function waitSessionSettled(
  events: PubSub.PubSub<OpencodeEvent>,
  sessionID: string,
  timeout: Duration.Duration,
): Effect.Effect<SessionWaitResult> {
  return Effect.suspend(() => {
    let latest: AssistantMessage | undefined
    const textById = new Map<string, string>()
    let structuredFromTool: unknown
    const timeoutMs = Duration.toMillis(timeout)

    const snapshot = (): Pick<SessionWaitResult, "textParts" | "structuredFromTool"> => ({
      textParts: [...textById.values()].map((text) => ({ type: "text", text })),
      structuredFromTool,
    })

    return Stream.fromPubSub(events).pipe(
      Stream.filter((e) => e.properties?.sessionID === sessionID),
      Stream.map((event) => {
        ingest(event)
        const errored = Boolean(latest?.error)
        const idle = event.type === "session.idle" && assistantTurnDone(latest)
        return errored || idle
      }),
      Stream.takeUntil((done) => done),
      Stream.runDrain,
      Effect.map((): SessionWaitResult => {
        const extras = snapshot()
        if (latest?.error) {
          return { ok: false, error: describeMessageError(latest.error), finalInfo: undefined, ...extras }
        }
        return { ok: true, finalInfo: latest, ...extras }
      }),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.succeed({
            ok: false,
            error: `检索超时(超过 ${timeoutMs / 1000} 秒)`,
            finalInfo: undefined,
            ...snapshot(),
          } satisfies SessionWaitResult),
      }),
    )

    function ingest(event: OpencodeEvent): void {
      if (event.type === "message.updated") {
        const info = event.properties.info
        if (isLiveAssistant(info)) latest = info
        return
      }
      if (event.type !== "message.part.updated") return
      const part = event.properties.part
      if (!part || typeof part !== "object") return
      const rec = part as Record<string, unknown>
      if (rec.type === "text" && typeof rec.id === "string" && typeof rec.text === "string") {
        textById.set(rec.id, rec.text)
        return
      }
      if (rec.type !== "tool" || typeof rec.tool !== "string") return
      if (!rec.tool.toLowerCase().includes("structuredoutput")) return
      const state = rec.state
      if (!state || typeof state !== "object") return
      const st = state as Record<string, unknown>
      if (st.input && typeof st.input === "object") structuredFromTool = st.input
      if (st.structured && typeof st.structured === "object") structuredFromTool = st.structured
    }
  })
}

function isLiveAssistant(info: unknown): info is AssistantMessage {
  if (!info || typeof info !== "object") return false
  const rec = info as { role?: unknown; summary?: unknown }
  return rec.role === "assistant" && rec.summary !== true
}

function assistantTurnDone(info: AssistantMessage | undefined): boolean {
  if (!info) return false
  if (info.error) return true
  if (info.structured != null) return true
  if (info.time?.completed == null) return false
  const finish = info.finish
  return finish != null && finish !== "tool-calls" && finish !== "unknown"
}
