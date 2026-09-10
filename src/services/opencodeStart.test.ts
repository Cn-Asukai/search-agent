import assert from "node:assert/strict"
import { test } from "node:test"
import { Cause } from "effect"
import { hintEmbeddedError } from "./opencode.js"

test("hintEmbeddedError unwraps Effect.tryPromise wrapper to EACCES", () => {
  const cause = new Error("EACCES: permission denied, mkdir '/home/node/.local/share/opencode/repos'")
  const wrapped = new Error("An error occurred in Effect.tryPromise", { cause })
  const hint = hintEmbeddedError(wrapped)
  assert.match(hint, /不可写/)
  assert.match(hint, /EACCES/)
  assert.doesNotMatch(hint, /An error occurred in Effect\.tryPromise/)
})

test("hintEmbeddedError unwraps Cause.UnknownError cause", () => {
  const cause = new Error("EACCES: permission denied, mkdir '/home/node/.local/share/opencode/repos'")
  const hint = hintEmbeddedError(new Cause.UnknownError(cause, "An error occurred in Effect.tryPromise"))
  assert.match(hint, /不可写/)
  assert.match(hint, /EACCES/)
})

test("hintEmbeddedError keeps missing CLI hint", () => {
  assert.match(hintEmbeddedError(new Error("spawn opencode ENOENT")), /未找到 opencode CLI/)
})
