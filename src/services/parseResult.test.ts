import assert from "node:assert/strict"
import { test } from "node:test"
import { parseFromTextParts, parseStructuredResult, resolveSearchResult } from "./opencode.js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

const valid = {
  verdict: "uncertain",
  confidence: "low",
  work: { original_title: "aaa", type: "other" },
  official: { exists: false },
  fan: { exists: false, translations: [] },
  sources: [],
  summary: "无法确认该作品",
}

test("parses a complete SearchResult", () => {
  const parsed = parseStructuredResult(valid)
  assert.ok(parsed)
  assert.equal(parsed.verdict, "uncertain")
  assert.equal(parsed.work.original_title, "aaa")
})

test("strips JSON-schema nulls on optional fields", () => {
  const withNulls = {
    ...valid,
    work: { original_title: "aaa", chinese_title: null, author: null, type: "other" },
    official: { exists: false, publisher: null, regions: null, evidence: null },
    fan: { exists: false, translations: [] },
  }
  const parsed = parseStructuredResult(withNulls)
  assert.ok(parsed, "null optionals must not fail Schema decode")
  assert.equal(parsed.work.chinese_title, undefined)
  assert.equal(parsed.official.publisher, undefined)
})

test("unwraps nested output/data wrappers", () => {
  assert.ok(parseStructuredResult({ output: valid }))
  assert.ok(parseStructuredResult({ data: valid }))
})

test("parses fenced JSON from text parts", () => {
  const parsed = parseFromTextParts([
    { type: "text", text: "结论如下:\n```json\n" + JSON.stringify(valid) + "\n```\n" },
  ])
  assert.ok(parsed)
  assert.equal(parsed.summary, valid.summary)
})

test("resolveSearchResult prefers message.structured then tool then text", () => {
  const info = { structured: valid } as AssistantMessage
  const fromInfo = resolveSearchResult({ info })
  assert.ok(fromInfo)

  const fromTool = resolveSearchResult({ structuredFromTool: valid })
  assert.ok(fromTool)

  const fromText = resolveSearchResult({
    parts: [{ type: "text", text: JSON.stringify(valid) }],
  })
  assert.ok(fromText)
})

test("rejects payloads missing required fields", () => {
  const { summary: _, ...missing } = valid
  assert.equal(parseStructuredResult(missing), null)
})

test("LLM json schema has no anyOf or minLength (opencode message decode)", async () => {
  const { searchResultJsonSchema } = await import("../domain/search.js")
  const blob = JSON.stringify(searchResultJsonSchema)
  assert.equal(blob.includes("anyOf"), false)
  assert.equal(blob.includes("minLength"), false)
  assert.equal(searchResultJsonSchema.type, "object")
})
