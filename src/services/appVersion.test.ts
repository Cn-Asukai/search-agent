import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { loadAppVersion, readAppVersion, readRevision } from "./appVersion.js"

test("readAppVersion returns the package version string", () => {
  assert.equal(readAppVersion('{"version":"0.1.0"}'), "0.1.0")
})

test("readAppVersion returns unknown when version is missing or invalid", () => {
  assert.equal(readAppVersion("{}"), "unknown")
  assert.equal(readAppVersion('{"version":""}'), "unknown")
  assert.equal(readAppVersion('{"version":1}'), "unknown")
  assert.equal(readAppVersion("{"), "unknown")
  assert.equal(readAppVersion(""), "unknown")
})

test("loadAppVersion returns unknown for a missing file", () => {
  const missing = join(dirname(fileURLToPath(import.meta.url)), "__missing_package.json__")
  assert.equal(loadAppVersion(missing), "unknown")
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
