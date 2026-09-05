/**
 * Local HTTP stub of POST /api/search (SSE), GET /api/search/:id, GET /api/search, GET /health.
 * Speaks the same event:/data: JSON framing as encodeSse. Used by client tests and flow verification.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { ProgressEntry, SearchResult, Task, WorkType } from "./searchClient.ts"

export type StubMode = "result" | "error"

export type ProtocolStub = {
  server: Server
  baseUrl: string
  lastSearchBody: unknown
  lastRequest: { method: string; url: string; accept: string } | null
  setMode: (mode: StubMode) => void
  close: () => Promise<void>
}

/** Same wire format as src/services/sseStream.ts encodeSse. */
export function encodeSse(event: string, data: unknown): string {
  const payload = JSON.stringify(data)
  return [`event: ${event}`, `data: ${payload}`, "", ""].join("\n")
}

export function sampleResult(query: string): SearchResult {
  return {
    verdict: "both",
    confidence: "high",
    work: {
      original_title: query,
      chinese_title: "转生成为剑",
      author: "田尾典丈",
      type: "novel",
    },
    official: {
      exists: true,
      publisher: "东立出版社",
      regions: ["台湾"],
      evidence: "台湾东立出版繁体中文版",
    },
    fan: {
      exists: true,
      translations: [
        {
          group: "某汉化组",
          status: "completed",
          source_url: "https://example.com/fan/tenken",
          note: "网络连载",
        },
      ],
    },
    sources: [
      { title: "Bangumi", url: "https://bgm.tv/subject/1", site: "bgm.tv", kind: "database" },
      { title: "东立", url: "https://www.tongli.com.tw/", site: "tongli.com.tw", kind: "official" },
    ],
    summary: `${query} 存在官方中文（东立）与民间汉化。`,
  }
}

function makeTask(query: string, type: WorkType, status: Task["status"]): Task {
  const now = Date.now()
  return {
    id: "stub-task-1",
    query,
    type,
    status,
    createdAt: now,
    updatedAt: now,
    progress: [],
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

export function startProtocolStub(port = 0): Promise<ProtocolStub> {
  let mode: StubMode = "result"
  let lastSearchBody: unknown
  let lastTask: Task | null = null
  let lastRequest: ProtocolStub["lastRequest"] = null

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    lastRequest = {
      method: req.method ?? "",
      url: url.pathname + url.search,
      accept: req.headers.accept ?? "",
    }
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          status: "ok",
          service: "search-agent-stub",
          opencode: { healthy: true, version: "stub" },
          runner: { active: 0, limit: 3, queued: 0, running: 0 },
          tasks: { total: lastTask ? 1 : 0, queued: 0, running: 0 },
          time: new Date().toISOString(),
        }),
      )
      return
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          tasks: lastTask
            ? [
                {
                  id: lastTask.id,
                  query: lastTask.query,
                  type: lastTask.type,
                  status: lastTask.status,
                  createdAt: lastTask.createdAt,
                  endedAt: lastTask.endedAt,
                  error: lastTask.error,
                },
              ]
            : [],
        }),
      )
      return
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/search/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/search/".length))
      if (!lastTask || lastTask.id !== id) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "任务不存在(服务重启后内存任务会被清除)" }))
        return
      }
      const accept = req.headers.accept ?? ""
      const stream = accept.includes("text/event-stream") || url.searchParams.get("stream") === "true"
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        })
        res.write(encodeSse("task", lastTask))
        if (lastTask.status === "error") res.write(encodeSse("error", lastTask))
        else if (lastTask.status === "done") res.write(encodeSse("result", lastTask))
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(lastTask))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      void (async () => {
        const body = (await readJson(req)) as Record<string, unknown>
        lastSearchBody = body
        const query = typeof body.query === "string" ? body.query : ""
        const type = (body.type === "novel" || body.type === "manga" || body.type === "unknown"
          ? body.type
          : "unknown") as WorkType
        const running = makeTask(query, type, "running")
        const progress: ProgressEntry = {
          seq: 1,
          ts: Date.now(),
          kind: "status",
          message: "正在联网搜索",
        }
        running.progress = [progress]

        if (mode === "error") {
          lastTask = {
            ...running,
            status: "error",
            endedAt: Date.now(),
            error: "检索超时",
          }
        } else {
          lastTask = {
            ...running,
            status: "done",
            endedAt: Date.now(),
            result: sampleResult(query),
          }
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        })
        res.write(encodeSse("task", running))
        res.write(encodeSse("progress", progress))
        if (mode === "error") res.write(encodeSse("error", lastTask))
        else res.write(encodeSse("result", lastTask))
        res.end()
      })()
      return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo
      const stub: ProtocolStub = {
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        get lastSearchBody() {
          return lastSearchBody
        },
        get lastRequest() {
          return lastRequest
        },
        setMode(next) {
          mode = next
        },
        close() {
          return new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()))
          })
        },
      }
      resolve(stub)
    })
  })
}


