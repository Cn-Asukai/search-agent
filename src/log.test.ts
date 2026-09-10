import assert from "node:assert/strict"
import { test } from "node:test"
import { formatError } from "./log.js"

test("formatError unwraps Effect.tryPromise wrapper", () => {
  const cause = new Error("EACCES: permission denied")
  const wrapped = new Error("An error occurred in Effect.tryPromise", { cause })
  assert.equal(formatError(wrapped), "EACCES: permission denied")
})

test("formatError keeps ordinary Error message", () => {
  assert.equal(formatError(new Error("boom")), "boom")
})
