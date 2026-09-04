import { Context, Effect, Fiber, Layer, Option, Stream } from "effect"
import { AppConfig } from "../env.js"
import { describePartEvent, EventBridge, type OpencodeEvent } from "./eventBridge.js"
import {
  OpenCode,
  OpenCodeOps,
  describeMessageError,
  resolveSearchResult,
} from "./opencode.js"
import { waitSessionSettled } from "./sessionWait.js"
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
        // 终态订阅与 prompt 同时启动,避免提交后再订而漏掉 idle
        const { outcome } = yield* Effect.all(
          {
            outcome: waitSessionSettled(bridge.events, sessionID, config.taskTimeout),
            submit: ops.submitSearch(sessionID, {
              query: task.query,
              type: task.type,
              stream: false,
            }),
          },
          { concurrency: 2 },
        )
        yield* stopWatch()

        const info = outcome.finalInfo as AssistantMessage | undefined
        let result: SearchResult | null = resolveSearchResult({
          info,
          structuredFromTool: outcome.structuredFromTool,
          parts: outcome.textParts,
        })

        // 事件里没解析出来时再拉一次消息(旧 messages 反序列化失败则忽略)
        if (!result) {
          const latest = yield* ops.getLatestAssistant(sessionID).pipe(Effect.option)
          if (Option.isSome(latest)) {
            result = resolveSearchResult({
              info: latest.value.info,
              structuredFromTool: outcome.structuredFromTool,
              parts: latest.value.parts,
            })
          }
        }

        if (result) {
          yield* tasks.appendProgress(taskId, { kind: "status", message: "检索完成,结论已生成" })
          yield* tasks.update(taskId, { status: "done", result, endedAt: Date.now() })
          return
        }

        if (!outcome.ok) {
          yield* ops.abortSession(sessionID).pipe(Effect.ignore)
          yield* tasks.update(taskId, {
            status: "error",
            error: outcome.error,
            endedAt: Date.now(),
          })
          return
        }
        if (info?.error) {
          yield* tasks.update(taskId, {
            status: "error",
            error: describeMessageError(info.error),
            endedAt: Date.now(),
          })
          return
        }

        yield* tasks.update(taskId, {
          status: "error",
          error: "模型未能返回符合 Schema 的结构化结果(可重试,或检查模型是否支持结构化输出)",
          endedAt: Date.now(),
        })
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
