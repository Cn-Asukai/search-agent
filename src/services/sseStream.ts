import { Effect, Option, Schedule, Stream, type PubSub } from "effect"
import type { SseClientEvent, Task, TaskEvent } from "../domain/search.js"

// ─────────────────────────────────────────────────────────────
// 对外 SSE:task → progress* → result | error,然后结束。
// 心跳只在检索进行中保活;终态事件会截断合并流,避免一直 ping。
// ─────────────────────────────────────────────────────────────

export type BuildSearchSseStreamOptions = {
  readonly taskId: string
  readonly events: PubSub.PubSub<TaskEvent>
  readonly getTask: (id: string) => Effect.Effect<Option.Option<Task>>
  readonly heartbeat?: Stream.Stream<SseClientEvent>
}

function defaultHeartbeat(): Stream.Stream<SseClientEvent> {
  return Stream.fromEffectSchedule(
    Effect.sync((): SseClientEvent => ({ event: "ping", data: { ts: Date.now() } })),
    Schedule.spaced("15 seconds"),
  )
}

export function buildSearchSseStream(
  options: BuildSearchSseStreamOptions,
): Stream.Stream<SseClientEvent> {
  const { taskId, events, getTask } = options
  const heartbeat = options.heartbeat ?? defaultHeartbeat()

  const live: Stream.Stream<SseClientEvent> = Stream.fromPubSub(events).pipe(
    Stream.filter((ev): ev is TaskEvent => ev.task.id === taskId),
    Stream.map(toClientEvent),
  )

  const snapshot: Stream.Stream<SseClientEvent> = Stream.fromEffect(getTask(taskId)).pipe(
    Stream.flatMap((opt) => Stream.fromIterable(snapshotEvents(opt))),
  )

  return Stream.merge(snapshot, Stream.merge(live, heartbeat)).pipe(
    Stream.takeUntil((ev) => ev.event === "result" || ev.event === "error"),
  )
}

export function encodeSse(ev: SseClientEvent): Uint8Array {
  const payload = JSON.stringify(ev.data)
  const lines = [`event: ${ev.event}`, `data: ${payload}`, "", ""]
  return new TextEncoder().encode(lines.join("\n"))
}

function toClientEvent(ev: TaskEvent): SseClientEvent {
  switch (ev._tag) {
    case "progress":
      return { event: "progress", data: ev.entry }
    case "done":
      return { event: "result", data: ev.task }
    case "error":
      return { event: "error", data: ev.task }
  }
}

function snapshotEvents(opt: Option.Option<Task>): readonly SseClientEvent[] {
  const task = Option.getOrNull(opt)
  const events: SseClientEvent[] = [{ event: "task", data: task }]
  if (task?.status === "done") events.push({ event: "result", data: task })
  if (task?.status === "error") events.push({ event: "error", data: task })
  return events
}
