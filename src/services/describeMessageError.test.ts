import assert from "node:assert/strict"
import { test } from "node:test"
import { describeMessageError } from "./opencode.js"

test("describeMessageError maps ProviderAuthError to a login hint", () => {
  assert.equal(
    describeMessageError({ name: "ProviderAuthError" }),
    "模型 provider 鉴权失败,请运行 `opencode auth login` 配置 API key",
  )
  assert.equal(
    describeMessageError({ name: "ProviderAuthError", message: "401" }),
    "模型 provider 鉴权失败,请运行 `opencode auth login` 配置 API key:401",
  )
})

test("describeMessageError maps StructuredOutputError and MessageAbortedError", () => {
  assert.equal(
    describeMessageError({ name: "StructuredOutputError", message: "bad schema" }),
    "结构化输出失败(模型可能不支持或结果不符合 Schema):bad schema",
  )
  assert.equal(describeMessageError({ name: "MessageAbortedError" }), "会话被中止")
})

test("describeMessageError maps APIError with optional HTTP status and detail", () => {
  assert.equal(
    describeMessageError({ name: "APIError" }),
    "模型 API 调用失败(请检查模型 API key、额度与网络)",
  )
  assert.equal(
    describeMessageError({
      name: "ApiError",
      data: { message: "quota", statusCode: 429 },
    }),
    "模型 API 调用失败 (HTTP 429):quota",
  )
})

test("describeMessageError falls back for unknown objects and non-objects", () => {
  assert.equal(
    describeMessageError({ name: "WeirdError", message: "boom" }),
    "模型调用出错:WeirdError:boom",
  )
  assert.equal(describeMessageError("timeout"), "模型调用出错:timeout")
  assert.equal(describeMessageError(null), "模型调用出错:null")
})
