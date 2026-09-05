import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  consumeSseChunk,
  createSearchClient,
  mapTaskToView,
  parseSseFrame,
  type Task,
} from "./searchClient.ts"
import { encodeSse, startProtocolStub, type ProtocolStub } from "./protocolStub.ts"

let stub: ProtocolStub | undefined

afterEach(async () => {
  if (stub) {
    await stub.close()
    stub = undefined
  }
})

describe("SSE framing (encodeSse shape)", () => {
  it("parses event/data JSON frames produced like encodeSse", () => {
    const progressBytes = encodeSse("progress", {
      seq: 1,
      ts: 1,
      kind: "status",
      message: "检索中",
    })
    const resultBytes = encodeSse("result", {
      id: "t1",
      query: "転生したら剣でした",
      type: "novel",
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      progress: [],
      result: {
        verdict: "both",
        confidence: "high",
        work: { original_title: "転生したら剣でした", type: "novel" },
        official: { exists: true, publisher: "东立出版社" },
        fan: { exists: true, translations: [] },
        sources: [{ url: "https://example.com", kind: "database" }],
        summary: "官方与民间均有",
      },
    })
    const { events, rest } = consumeSseChunk("", progressBytes + resultBytes)
    expect(rest).toBe("")
    expect(events.map((e) => e.event)).toEqual(["progress", "result"])
    const progress = events[0]
    expect(progress?.event).toBe("progress")
    expect((progress?.data as { message: string }).message).toBe("检索中")
    const resultEv = events[1]
    const view = mapTaskToView(resultEv?.data as Task)
    expect(view.kind).toBe("result")
    expect(view.verdict).toBe("both")
    expect(view.official?.exists).toBe(true)
    expect(view.fan?.exists).toBe(true)
    expect(view.sources?.[0]?.url).toBe("https://example.com")
    expect(view.summary).toBe("官方与民间均有")
  })

  it("parseSseFrame matches encodeSse line layout", () => {
    const raw = new TextDecoder().decode(
      new TextEncoder().encode(encodeSse("error", { id: "t", query: "x", type: "manga", status: "error", error: "boom" })),
    )
    expect(raw.startsWith("event: error\ndata: ")).toBe(true)
    expect(raw.endsWith("\n\n")).toBe(true)
    const parsed = parseSseFrame(raw.trimEnd())
    expect(parsed?.event).toBe("error")
    expect((parsed?.data as { error: string }).error).toBe("boom")
  })
})

describe("shipped search client against HTTP SSE stub", () => {
  it("POSTs stream:true and maps progress + result fields from SSE", async () => {
    stub = await startProtocolStub()
    const capturedBodies: unknown[] = []
    const originalFetch = globalThis.fetch.bind(globalThis)
    const client = createSearchClient({
      baseUrl: stub.baseUrl,
      fetch: async (input, init) => {
        if (init?.body && typeof init.body === "string") {
          capturedBodies.push(JSON.parse(init.body))
        }
        return originalFetch(input, init)
      },
    })

    const progressMessages: string[] = []
    const session = await client.searchStream(
      { query: "転生したら剣でした", type: "novel" },
      { onProgress: (entry) => progressMessages.push(entry.message) },
    )

    expect(capturedBodies[0]).toEqual({
      query: "転生したら剣でした",
      type: "novel",
      stream: true,
    })
    expect((stub.lastSearchBody as { query: string }).query.length).toBeGreaterThan(0)
    expect(["novel", "manga", "unknown"]).toContain((stub.lastSearchBody as { type: string }).type)
    expect((stub.lastSearchBody as { stream: boolean }).stream).toBe(true)

    expect(progressMessages).toContain("正在联网搜索")
    expect(session.view?.kind).toBe("result")
    expect(session.view?.verdict).toBe("both")
    expect(session.view?.official?.exists).toBe(true)
    expect(session.view?.official?.publisher).toBe("东立出版社")
    expect(session.view?.fan?.exists).toBe(true)
    expect(session.view?.fan?.translations?.[0]?.source_url).toContain("http")
    expect(session.view?.sources?.some((s) => s.url.startsWith("http"))).toBe(true)
    expect(session.view?.summary).toMatch(/官方中文/)
  })

  it("surfaces the task error event from SSE", async () => {
    stub = await startProtocolStub()
    stub.setMode("error")
    const client = createSearchClient({ baseUrl: stub.baseUrl })
    const session = await client.searchStream({ query: "不存在的作品xyz", type: "manga" })
    expect(session.view?.kind).toBe("error")
    expect(session.view?.error).toBe("检索超时")
    expect((stub.lastSearchBody as { type: string }).type).toBe("manga")
    expect((stub.lastSearchBody as { stream: boolean }).stream).toBe(true)
  })

  it("completes on result even if the server keeps pinging", async () => {
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const running = {
        id: "keep-alive-1",
        query: "ping-after-result",
        type: "novel",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        progress: [],
      }
      const done = {
        ...running,
        status: "done",
        result: {
          verdict: "none",
          confidence: "low",
          work: { original_title: "ping-after-result", type: "novel" },
          official: { exists: false },
          fan: { exists: false, translations: [] },
          sources: [{ url: "https://example.com/src", kind: "other" }],
          summary: "无中文版本",
        },
      }
      res.write(encodeSse("task", running))
      res.write(encodeSse("progress", { seq: 1, ts: 1, kind: "status", message: "检索中" }))
      res.write(encodeSse("result", done))
      const timer = setInterval(() => {
        res.write(encodeSse("ping", { ts: Date.now() }))
      }, 15)
      req.on("close", () => {
        clearInterval(timer)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address() as AddressInfo
    try {
      const client = createSearchClient({ baseUrl: `http://127.0.0.1:${addr.port}` })
      const session = await Promise.race([
        client.searchStream({ query: "ping-after-result", type: "novel" }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("client did not finish after terminal result")), 800)
        }),
      ])
      expect(session.view?.kind).toBe("result")
      expect(session.view?.verdict).toBe("none")
      expect(session.view?.summary).toBe("无中文版本")
      expect(session.progress.map((p) => p.message)).toContain("检索中")
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })

  it("GET /api/search/:id returns the task after a stream", async () => {
    stub = await startProtocolStub()
    const client = createSearchClient({ baseUrl: stub.baseUrl })
    const streamed = await client.searchStream({ query: "ソードアート・オンライン", type: "unknown" })
    expect(streamed.task?.id).toBeTruthy()
    const fetched = await client.getTask(streamed.task!.id)
    expect(fetched.id).toBe(streamed.task!.id)
    expect(fetched.result?.verdict).toBe("both")
    expect(fetched.result?.summary).toMatch(/ソードアート/)
    const view = mapTaskToView(fetched)
    expect(view.official?.exists).toBe(true)
    expect(view.fan?.exists).toBe(true)
  })
})
