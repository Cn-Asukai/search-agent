import assert from "node:assert/strict"
import { test } from "node:test"
import { readRevision, resolveAppVersion } from "./appVersion.js"

test("resolveAppVersion prefers GIT_VERSION env over git describe", () => {
  assert.equal(resolveAppVersion("v0.2.4", () => "v0.1.0"), "v0.2.4")
})

test("resolveAppVersion trims GIT_VERSION", () => {
  assert.equal(resolveAppVersion("  v0.2.4\n", () => "nope"), "v0.2.4")
})

test("resolveAppVersion treats blank env as missing and uses git describe", () => {
  assert.equal(resolveAppVersion(undefined, () => "v0.2.4-1-g87b5548"), "v0.2.4-1-g87b5548")
  assert.equal(resolveAppVersion("", () => "v0.2.4"), "v0.2.4")
  assert.equal(resolveAppVersion("   ", () => "v0.2.4"), "v0.2.4")
})

test("resolveAppVersion returns unknown when env and git are missing", () => {
  assert.equal(resolveAppVersion(undefined, () => null), "unknown")
  assert.equal(resolveAppVersion("", () => null), "unknown")
})

test("resolveAppVersion reads a git tag from this repository", () => {
  const version = resolveAppVersion(undefined)
  assert.notEqual(version, "unknown")
  assert.match(version, /^v?\d+\.\d+/)
})

test("readRevision treats missing and blank env as null", () => {
  assert.equal(readRevision(undefined), null)
  assert.equal(readRevision(""), null)
  assert.equal(readRevision("  "), null)
})

test("readRevision returns the trimmed SHA without truncating", () => {
  assert.equal(readRevision("abc123def"), "abc123def")
  assert.equal(
    readRevision("d2adaeff2dceb3330e423c23ff06161d35de89d4"),
    "d2adaeff2dceb3330e423c23ff06161d35de89d4",
  )
})
