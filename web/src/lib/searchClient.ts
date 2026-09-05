/**
 * Shipped HTTP/SSE client for this service's search API.
 *
 * Contract (same framing as src/services/sseStream.ts encodeSse):
 *   POST /api/search { query, type, stream: true }
 *   events: task → progress* → result | error
 *   GET /api/search/:id  re-fetch a task
 *   GET /api/search      recent list
 *   GET /health
 */

export const WORK_TYPES = ["novel", "manga", "unknown"] as const
export type WorkType = (typeof WORK_TYPES)[number]

export const workTypeLabels: Record<WorkType, string> = {
  novel: "轻小说",
  manga: "漫画",
  unknown: "未指定",
}

export type ProgressEntry = {
  seq: number
  ts: number
  kind: "status" | "tool" | "text"
  message: string
  tool?: string
  state?: "running" | "completed" | "error"
  detail?: string
}

export type Translation = {
  group?: string
  status: "ongoing" | "completed" | "dropped" | "unknown"
  progress?: string
  source_url: string
  note?: string
}

export type Source = {
  title?: string
  url: string
  site?: string
  kind: "official" | "fan-translation" | "database" | "forum" | "other"
}

export type SearchResult = {
  verdict: "official" | "fan" | "both" | "none" | "uncertain"
  confidence: "high" | "medium" | "low"
  work: {
    original_title: string
    chinese_title?: string
    author?: string
    type: "novel" | "manga" | "other"
  }
  official: {
    exists: boolean
    publisher?: string
    regions?: string[]
    evidence?: string
  }
  fan: {
    exists: boolean
    translations: Translation[]
  }
  sources: Source[]
  summary: string
}

export type Task = {
  id: string
  query: string
  type: WorkType
  status: "queued" | "running" | "done" | "error"
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  sessionId?: string
  progress: ProgressEntry[]
  result?: SearchResult
  error?: string
}

export type TaskSummary = {
  id: string
  query: string
  type: WorkType
  status: Task["status"]
  createdAt: number
  endedAt?: number
  error?: string
}

export type HealthInfo = {
  status: string
  service?: string
  opencode?: { url?: string; healthy?: boolean; version?: string }
  runner?: { active?: number; limit?: number; queued?: number; running?: number }
  tasks?: { total?: number; queued?: number; running?: number }
  time?: string
}

export type ParsedSseEvent = {
  event: string
  data: unknown
}

export type MappedSearchView = {
  kind: "result" | "error"
  taskId: string
  query: string
  type: WorkType
  status: Task["status"]
  error?: string
  verdict?: SearchResult["verdict"]
  confidence?: SearchResult["confidence"]
  work?: SearchResult["work"]
  official?: SearchResult["official"]
  fan?: SearchResult["fan"]
  sources?: SearchResult["sources"]
  summary?: string
}

export type SearchSession = {
  task: Task | null
  progress: ProgressEntry[]
  view: MappedSearchView | null
}

export type SearchStreamHandlers = {
  onEvent?: (event: ParsedSseEvent) => void
  onTask?: (task: Task) => void
  onProgress?: (entry: ProgressEntry) => void
  onResult?: (view: MappedSearchView) => void
  onError?: (view: MappedSearchView) => void
  signal?: AbortSignal
}

export type SearchClientConfig = {
  /** Empty string = same-origin (Vite proxy). */
  baseUrl?: string
  fetch?: typeof fetch
}

const WORK_TYPE_SET = new Set<string>(WORK_TYPES)

export function isWorkType(value: string): value is WorkType {
  return WORK_TYPE_SET.has(value)
}

/** Split a byte buffer into complete SSE frames (`\\n\\n` terminated), matching encodeSse. */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const frames: string[] = []
  let rest = normalized
  while (true) {
    const idx = rest.indexOf("\n\n")
    if (idx < 0) break
    const frame = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    if (frame.trim().length > 0) frames.push(frame)
  }
  return { frames, rest }
}

/** Parse one SSE frame of the form `event: name\\ndata: <json>`. */
export function parseSseFrame(frame: string): ParsedSseEvent | null {
  const lines = frame.replace(/\r\n/g, "\n").split("\n")
  let event = "message"
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith(":") || line.trim() === "") continue
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim()
      continue
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join("\n")
  let data: unknown = raw
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  return { event, data }
}

export function consumeSseChunk(
  buffer: string,
  chunk: string,
): { events: ParsedSseEvent[]; rest: string } {
  const { frames, rest } = splitSseFrames(buffer + chunk)
  const events: ParsedSseEvent[] = []
  for (const frame of frames) {
    const parsed = parseSseFrame(frame)
    if (parsed) events.push(parsed)
  }
  return { events, rest }
}

export function mapTaskToView(task: Task): MappedSearchView {
  if (task.status === "error" || (task.error && task.status !== "done")) {
    return {
      kind: "error",
      taskId: task.id,
      query: task.query,
      type: task.type,
      status: task.status,
      error: task.error ?? "检索失败",
    }
  }
  const result = task.result
  return {
    kind: "result",
    taskId: task.id,
    query: task.query,
    type: task.type,
    status: task.status,
    verdict: result?.verdict,
    confidence: result?.confidence,
    work: result?.work,
    official: result?.official,
    fan: result?.fan,
    sources: result?.sources,
    summary: result?.summary,
  }
}

export function applySseEvent(session: SearchSession, ev: ParsedSseEvent): void {
  if (ev.event === "ping") return
  if (ev.event === "task") {
    session.task = asTask(ev.data, session.task)
    if (session.task?.progress.length) {
      session.progress = [...session.task.progress]
    }
    return
  }
  if (ev.event === "progress") {
    const entry = asProgress(ev.data)
    if (entry) {
      session.progress.push(entry)
      if (session.task) {
        session.task = {
          ...session.task,
          progress: [...session.task.progress, entry],
        }
      }
    }
    return
  }
  if (ev.event === "result" || ev.event === "error") {
    const task = asTask(ev.data, session.task)
    if (task) {
      if (ev.event === "error" && !task.error) {
        task.error = "检索失败"
        if (task.status !== "error") task.status = "error"
      }
      session.task = task
      session.view = mapTaskToView(task)
    }
  }
}

function asProgress(data: unknown): ProgressEntry | null {
  if (!data || typeof data !== "object") return null
  const rec = data as Record<string, unknown>
  if (typeof rec.message !== "string") return null
  return {
    seq: typeof rec.seq === "number" ? rec.seq : sessionSeqFallback(rec),
    ts: typeof rec.ts === "number" ? rec.ts : Date.now(),
    kind: rec.kind === "tool" || rec.kind === "text" ? rec.kind : "status",
    message: rec.message,
    tool: typeof rec.tool === "string" ? rec.tool : undefined,
    state:
      rec.state === "running" || rec.state === "completed" || rec.state === "error"
        ? rec.state
        : undefined,
    detail: typeof rec.detail === "string" ? rec.detail : undefined,
  }
}

function sessionSeqFallback(rec: Record<string, unknown>): number {
  return typeof rec.seq === "number" ? rec.seq : 0
}

function asTask(data: unknown, previous: Task | null): Task | null {
  if (!data || typeof data !== "object") return previous
  const rec = data as Record<string, unknown>
  const id = typeof rec.id === "string" ? rec.id : previous?.id
  const query = typeof rec.query === "string" ? rec.query : previous?.query
  if (!id || !query) return previous
  const type = isWorkType(String(rec.type ?? previous?.type ?? "unknown"))
    ? (rec.type as WorkType)
    : (previous?.type ?? "unknown")
  const status = isTaskStatus(rec.status) ? rec.status : (previous?.status ?? "running")
  const progress = Array.isArray(rec.progress)
    ? rec.progress.map(asProgress).filter((e): e is ProgressEntry => e !== null)
    : (previous?.progress ?? [])
  return {
    id,
    query,
    type,
    status,
    createdAt: typeof rec.createdAt === "number" ? rec.createdAt : (previous?.createdAt ?? Date.now()),
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now(),
    startedAt: typeof rec.startedAt === "number" ? rec.startedAt : previous?.startedAt,
    endedAt: typeof rec.endedAt === "number" ? rec.endedAt : previous?.endedAt,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : previous?.sessionId,
    progress,
    result: rec.result && typeof rec.result === "object" ? (rec.result as SearchResult) : previous?.result,
    error: typeof rec.error === "string" ? rec.error : previous?.error,
  }
}

function isTaskStatus(value: unknown): value is Task["status"] {
  return value === "queued" || value === "running" || value === "done" || value === "error"
}

function joinUrl(base: string, path: string): string {
  if (!base) return path
  return `${base.replace(/\/$/, "")}${path}`
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ParsedSseEvent) => void,
  options?: { isTerminal?: (event: ParsedSseEvent) => boolean },
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const isTerminal = options?.isTerminal ?? ((ev: ParsedSseEvent) => ev.event === "result" || ev.event === "error")
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) {
          const parsed = parseSseFrame(buffer)
          if (parsed) onEvent(parsed)
        }
        break
      }
      const chunk = decoder.decode(value, { stream: true })
      const consumed = consumeSseChunk(buffer, chunk)
      buffer = consumed.rest
      for (const ev of consumed.events) {
        onEvent(ev)
        if (isTerminal(ev)) {
          try {
            await reader.cancel()
          } catch {
            // already closed
          }
          return
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // cancel() already released the lock
    }
  }
}

export function createSearchClient(config: SearchClientConfig = {}) {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis)
  const baseUrl = config.baseUrl ?? ""

  async function searchStream(
    input: { query: string; type: WorkType },
    handlers: SearchStreamHandlers = {},
  ): Promise<SearchSession> {
    const query = input.query.trim()
    if (!query) throw new Error("query 不能为空")
    if (!isWorkType(input.type)) throw new Error("type 必须是 novel、manga 或 unknown")

    const res = await fetchImpl(joinUrl(baseUrl, "/api/search"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ query, type: input.type, stream: true }),
      signal: handlers.signal,
    })
    return consumeSearchSse(res, handlers, "检索请求失败")
  }

  async function attachStream(id: string, handlers: SearchStreamHandlers = {}): Promise<SearchSession> {
    const taskId = id.trim()
    if (!taskId) throw new Error("缺少任务 id")
    const res = await fetchImpl(joinUrl(baseUrl, `/api/search/${encodeURIComponent(taskId)}`), {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: handlers.signal,
    })
    return consumeSearchSse(res, handlers, "续接任务失败")
  }

  async function consumeSearchSse(
    res: Response,
    handlers: SearchStreamHandlers,
    errorPrefix: string,
  ): Promise<SearchSession> {
    if (!res.ok) {
      const text = await res.text()
      throw new Error(httpErrorMessage(errorPrefix, res.status, text))
    }
    if (!res.body) throw new Error("检索响应没有 body")

    const session: SearchSession = { task: null, progress: [], view: null }
    await readSseStream(res.body, (ev) => {
      handlers.onEvent?.(ev)
      applySseEvent(session, ev)
      if (ev.event === "task" && session.task) handlers.onTask?.(session.task)
      if (ev.event === "progress") {
        const last = session.progress.at(-1)
        if (last) handlers.onProgress?.(last)
      }
      if (ev.event === "result" && session.view) handlers.onResult?.(session.view)
      if (ev.event === "error" && session.view) handlers.onError?.(session.view)
    })

    if (!session.view && session.task?.id) {
      const task = await getTask(session.task.id)
      session.task = task
      if (task.progress.length) session.progress = [...task.progress]
      if (task.status === "done" || task.status === "error") {
        session.view = mapTaskToView(task)
        if (session.view.kind === "result") handlers.onResult?.(session.view)
        else handlers.onError?.(session.view)
      }
    }

    return session
  }

  async function getTask(id: string): Promise<Task> {
    const res = await fetchImpl(joinUrl(baseUrl, `/api/search/${encodeURIComponent(id)}`), {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(httpErrorMessage("获取任务失败", res.status, text))
    }
    const json: unknown = await res.json()
    const task = asTask(json, null)
    if (!task) throw new Error("任务响应无法解析")
    return task
  }

  async function listRecent(): Promise<TaskSummary[]> {
    const res = await fetchImpl(joinUrl(baseUrl, "/api/search"), {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`获取任务列表失败 (${res.status})`)
    const json: unknown = await res.json()
    if (!json || typeof json !== "object") return []
    const tasks = (json as { tasks?: unknown }).tasks
    if (!Array.isArray(tasks)) return []
    return tasks.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const rec = item as Record<string, unknown>
      if (typeof rec.id !== "string" || typeof rec.query !== "string") return []
      const type = isWorkType(String(rec.type ?? "unknown")) ? (rec.type as WorkType) : "unknown"
      return [
        {
          id: rec.id,
          query: rec.query,
          type,
          status: isTaskStatus(rec.status) ? rec.status : "queued",
          createdAt: typeof rec.createdAt === "number" ? rec.createdAt : 0,
          endedAt: typeof rec.endedAt === "number" ? rec.endedAt : undefined,
          error: typeof rec.error === "string" ? rec.error : undefined,
        },
      ]
    })
  }

  async function health(): Promise<HealthInfo> {
    const res = await fetchImpl(joinUrl(baseUrl, "/health"), {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`health ${res.status}`)
    return (await res.json()) as HealthInfo
  }

  return { searchStream, attachStream, getTask, listRecent, health }
}

function httpErrorMessage(prefix: string, status: number, text: string): string {
  try {
    const json: unknown = JSON.parse(text)
    if (json && typeof json === "object" && "error" in json && typeof (json as { error: unknown }).error === "string") {
      return `${prefix} (${status}): ${(json as { error: string }).error}`
    }
  } catch {
    // not JSON
  }
  return `${prefix} (${status}): ${text.slice(0, 200)}`
}

export const verdictLabels: Record<SearchResult["verdict"], string> = {
  official: "仅官方中文",
  fan: "仅民间汉化",
  both: "官方与民间均有",
  none: "暂无中文版本",
  uncertain: "无法确定",
}

export const sourceKindLabels: Record<Source["kind"], string> = {
  official: "官方",
  "fan-translation": "民间汉化",
  database: "资料库",
  forum: "论坛",
  other: "其他",
}
