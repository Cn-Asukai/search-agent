import { Context, Duration, Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import { AppConfig } from "../env.js"
import { describePartEvent, EventBridge, type OpencodeEvent } from "./eventBridge.js"
import {
  OpenCode,
  OpenCodeOps,
  describeMessageError,
  parseFromTextParts,
  parseStructuredResult,
} from "./opencode.js"
import { TaskManager } from "./taskManager.js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { SearchResult } from "../domain/search.js"

// ─────────────────────────────────────────────────────────────
// 检索任务执行器:信号量限流 → 建会话 → promptAsync 异步提交
// → 事件流等待终态 → 拉消息解析结构化输出 → 写回任务表
// ─────────────────────────────────────────────────────────────

export class SearchRunner extends Context.Service<SearchRunner, {
  /** 启动一个检索任务(排队/执行),不阻塞调用方 */
  readonly launch: (taskId: string) => Effect.Effect<void>
}>()("SearchRunner") {}

export const SearchRunnerLive: Layer.Layer<
  SearchRunner,
  never,
  OpenCode | OpenCodeOps | TaskManager | EventBridge | AppConfig
> = Layer.effect(
  SearchRunner
)(Effect.gen(function* () {
    const opencode = yield* OpenCode
    const ops = yield* OpenCodeOps
    const tasks = yield* TaskManager
    const bridge = yield* EventBridge
    const config = yield* AppConfig

    /** 监听某个 session 的事件(工具调用 → 进度),返回取消函数 */
    const watchSession = (
      sessionID: string,
      taskId: string,
    ): Effect.Effect<() => Effect.Effect<void>> =>
      Stream.fromPubSub(bridge.events).pipe(
        Stream.filter(
          (e): e is OpencodeEvent & { properties: { sessionID: string } } =>
            e.properties?.sessionID === sessionID,
        ),
        Stream.tap((event) => {
          if (event.type === "message.part.updated") {
            const entry = describePartEvent(event)
            if (entry) return tasks.appendProgress(taskId, entry)
          }
          return Effect.void
        }),
        Stream.runDrain,
        Effect.forkDetach,
        Effect.map((fiber) => () => Fiber.interrupt(fiber).pipe(Effect.ignore)),
      )

    /** 等待会话终态:Stream 消费事件,捕获最终消息 + timeoutOrElse 超时 */
    const waitSessionSettled = (sessionID: string) => {
      const timeoutMs = Duration.toMillis(config.taskTimeout)
      let hasAssistant = false
      let assistantError: unknown
      let finalInfo: unknown

      const waitFor = Stream.fromPubSub(bridge.events).pipe(
        Stream.filter((e) => e.properties?.sessionID === sessionID),
        Stream.tap((event) => {
          if (event.type === "message.updated") {
            const info = event.properties.info
            if (info && typeof info === "object" && (info as { role?: unknown }).role === "assistant") {
              hasAssistant = true
              finalInfo = info
              const err = (info as { error?: unknown }).error
              if (err) assistantError = err
            }
          }
          if (event.type === "session.idle" && hasAssistant) {
            // idle 事件后是最终状态
          }
          return Effect.void
        }),
        Stream.takeWhile(() => {
          if (assistantError) return false
          if (hasAssistant) return false
          return true
        }),
        Stream.runDrain,
        Effect.map(() => {
          if (assistantError) {
            return { ok: false, error: describeMessageError(assistantError), finalInfo: undefined }
          }
          return { ok: true, finalInfo }
        }),
      )
      return waitFor.pipe(
        Effect.timeoutOrElse({
          duration: config.taskTimeout,
          orElse: () =>
            Effect.succeed({
              ok: false,
              error: `检索超时(超过 ${timeoutMs / 1000} 秒)`,
              finalInfo: undefined,
            }),
        }),
      )
    }

    /** 执行单个任务(入口,不抛异常,结果写回任务表) */
    const runTask = (taskId: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const taskOpt = yield* tasks.get(taskId)
        if (Option.isNone(taskOpt)) return
        const task = Option.getOrThrow(taskOpt)

        yield* tasks.update(taskId, { status: "running", startedAt: Date.now() })
        yield* tasks.appendProgress(taskId, { kind: "status", message: "任务开始,正在创建检索会话" })

        const sessionID = yield* ops.createSession
        yield* tasks.update(taskId, { sessionId: sessionID })
        yield* tasks.appendProgress(taskId, {
          kind: "status",
          message: "会话已创建,正在分析并联网检索",
        })

        // 订阅该会话的工具调用事件 → 进度
        const stopWatch = yield* watchSession(sessionID, taskId)

        // 异步提交
        yield* ops.submitSearch(sessionID, {
          query: task.query,
          type: task.type,
          stream: false,
        })

        // 等待终态
        const outcome = yield* waitSessionSettled(sessionID)

        yield* stopWatch()

        if (!outcome.ok) {
          // 超时/失败 → 中止会话
          yield* ops.abortSession(sessionID).pipe(Effect.ignore)
          yield* tasks.update(taskId, {
            status: "error",
            error: outcome.error,
            endedAt: Date.now(),
          })
          return
        }

        // 取结果(优先用事件捕获的最终消息,避免 messages 端点反序列化 bug)
        const info = outcome.finalInfo as AssistantMessage | undefined
        if (!info) {
          yield* tasks.update(taskId, {
            status: "error",
            error: "未能获取模型最终消息",
            endedAt: Date.now(),
          })
          return
        }
        if (info.error) {
          yield* tasks.update(taskId, {
            status: "error",
            error: describeMessageError(info.error),
            endedAt: Date.now(),
          })
          return
        }

        const result: SearchResult | null = parseStructuredResult(info.structured)
        if (!result) {
          yield* tasks.update(taskId, {
            status: "error",
            error: "模型未能返回符合 Schema 的结构化结果(可重试,或检查模型是否支持结构化输出)",
            endedAt: Date.now(),
          })
          return
        }

        yield* tasks.appendProgress(taskId, { kind: "status", message: "检索完成,结论已生成" })
        yield* tasks.update(taskId, { status: "done", result, endedAt: Date.now() })
      })

    const launch = (taskId: string) =>
      // 信号量限流:超出则排队(take/release 手动管理,避免 withPermits 的
      // uninterruptible 包裹导致内部计时器失效)
      Effect.gen(function* () {
        yield* tasks.semaphore.take(1)
        yield* runTask(taskId).pipe(
          Effect.catch((err) =>
            tasks.update(taskId, {
              status: "error",
              error: err instanceof Error ? err.message : String(err),
              endedAt: Date.now(),
            }),
          ),
          Effect.ensuring(tasks.semaphore.release(1)),
        )
      }).pipe(Effect.forkDetach, Effect.as(undefined as void))

    return { launch }
  }))
