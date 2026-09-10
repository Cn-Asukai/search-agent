import assert from "node:assert/strict"
import { test } from "node:test"
import { Schema } from "effect"
import {
  SearchRequest,
  SearchResult,
  reconcileVerdict,
  type SearchResult as SearchResultType,
} from "./search.js"

const validResult: SearchResultType = {
  verdict: "uncertain",
  confidence: "low",
  work: { original_title: "転生したら剣でした", type: "novel" },
  official: { exists: false },
  fan: { exists: false, translations: [] },
  sources: [],
  summary: "无法确认",
}

test("SearchRequest accepts a complete payload", () => {
  const decoded = Schema.decodeUnknownOption(SearchRequest)({
    query: "転生したら剣でした",
    type: "novel",
    stream: true,
  })
  assert.equal(decoded._tag, "Some")
  assert.equal(decoded._tag === "Some" ? decoded.value.query : "", "転生したら剣でした")
  assert.equal(decoded._tag === "Some" ? decoded.value.type : "", "novel")
})

test("SearchRequest rejects empty query and invalid type", () => {
  assert.equal(
    Schema.decodeUnknownOption(SearchRequest)({ query: "", type: "novel", stream: false })._tag,
    "None",
  )
  assert.equal(
    Schema.decodeUnknownOption(SearchRequest)({ query: "x", type: "film", stream: false })._tag,
    "None",
  )
  assert.equal(
    Schema.decodeUnknownOption(SearchRequest)({ type: "novel", stream: false })._tag,
    "None",
  )
})

test("SearchResult accepts a complete payload and rejects missing required fields", () => {
  assert.equal(Schema.decodeUnknownOption(SearchResult)(validResult)._tag, "Some")
  const { summary: _, ...missingSummary } = validResult
  assert.equal(Schema.decodeUnknownOption(SearchResult)(missingSummary)._tag, "None")
  assert.equal(
    Schema.decodeUnknownOption(SearchResult)({ ...validResult, verdict: "maybe" })._tag,
    "None",
  )
})

test("reconcileVerdict maps official/fan existence onto verdict", () => {
  const translation = { status: "ongoing" as const, source_url: "https://example.test/fan" }

  const officialOnly = reconcileVerdict({
    ...validResult,
    verdict: "uncertain",
    official: { exists: true, publisher: "东立" },
    fan: { exists: false, translations: [] },
  })
  assert.equal(officialOnly.verdict, "official")

  const fanOnly = reconcileVerdict({
    ...validResult,
    verdict: "none",
    official: { exists: false },
    fan: { exists: true, translations: [translation] },
  })
  assert.equal(fanOnly.verdict, "fan")

  const both = reconcileVerdict({
    ...validResult,
    verdict: "official",
    official: { exists: true },
    fan: { exists: true, translations: [translation] },
  })
  assert.equal(both.verdict, "both")
})

test("reconcileVerdict leaves none/uncertain unchanged when neither category exists", () => {
  const none = { ...validResult, verdict: "none" as const }
  const uncertain = { ...validResult, verdict: "uncertain" as const }
  assert.equal(reconcileVerdict(none), none)
  assert.equal(reconcileVerdict(uncertain), uncertain)
  assert.equal(reconcileVerdict(none).verdict, "none")
  assert.equal(reconcileVerdict(uncertain).verdict, "uncertain")
})

test("reconcileVerdict returns the same object when verdict already matches existence", () => {
  const already = {
    ...validResult,
    verdict: "official" as const,
    official: { exists: true },
  }
  assert.equal(reconcileVerdict(already), already)
})
