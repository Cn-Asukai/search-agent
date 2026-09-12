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
  official: { status: "not_found" },
  fan: { status: "not_found", translations: [] },
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

test("reconcileVerdict maps official/fan confirmation onto verdict", () => {
  const translation = { status: "ongoing" as const, source_url: "https://example.test/fan" }

  const officialOnly = reconcileVerdict({
    ...validResult,
    verdict: "uncertain",
    official: { status: "confirmed", publisher: "东立" },
    fan: { status: "not_found", translations: [] },
  })
  assert.equal(officialOnly.verdict, "official")

  const fanOnly = reconcileVerdict({
    ...validResult,
    verdict: "none",
    official: { status: "not_found" },
    fan: { status: "confirmed", translations: [translation] },
  })
  assert.equal(fanOnly.verdict, "fan")

  const both = reconcileVerdict({
    ...validResult,
    verdict: "official",
    official: { status: "confirmed" },
    fan: { status: "confirmed", translations: [translation] },
  })
  assert.equal(both.verdict, "both")
})

test("reconcileVerdict maps both not_found onto none", () => {
  const none = { ...validResult, verdict: "none" as const }
  assert.equal(reconcileVerdict(none), none)
  assert.equal(reconcileVerdict(none).verdict, "none")
  const fromUncertain = reconcileVerdict({ ...validResult, verdict: "uncertain" as const })
  assert.equal(fromUncertain.verdict, "none")
})

test("reconcileVerdict keeps uncertain when a branch is unknown", () => {
  const bothUnknown = reconcileVerdict({
    ...validResult,
    official: { status: "unknown" },
    fan: { status: "unknown", translations: [] },
  })
  assert.equal(bothUnknown.verdict, "uncertain")

  const mixed = reconcileVerdict({
    ...validResult,
    verdict: "none",
    official: { status: "not_found" },
    fan: { status: "unknown", translations: [] },
  })
  assert.equal(mixed.verdict, "uncertain")
})

test("reconcileVerdict treats confirmed plus unknown as official or fan", () => {
  const translation = { status: "ongoing" as const, source_url: "https://example.test/fan" }

  const officialUnknownFan = reconcileVerdict({
    ...validResult,
    official: { status: "confirmed", publisher: "东立" },
    fan: { status: "unknown", translations: [] },
  })
  assert.equal(officialUnknownFan.verdict, "official")

  const unknownOfficialFan = reconcileVerdict({
    ...validResult,
    official: { status: "unknown" },
    fan: { status: "confirmed", translations: [translation] },
  })
  assert.equal(unknownOfficialFan.verdict, "fan")
})

test("reconcileVerdict returns the same object when verdict already matches confirmation", () => {
  const already = {
    ...validResult,
    verdict: "official" as const,
    official: { status: "confirmed" },
  }
  assert.equal(reconcileVerdict(already), already)
})
