import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")

function readRepo(rel: string): string {
  return readFileSync(join(root, rel), "utf8")
}

function uncommentedLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && !/^\s*\/\//.test(line))
}

test("websearch listens on all interfaces, not loopback-only", () => {
  const yaml = readRepo("websearch.config.yaml")
  const active = uncommentedLines(yaml).join("\n")
  const host = /^\s*host:\s*["']?([^"'#\s]+)/m.exec(active)
  assert.ok(host, "websearch.config.yaml must set host (not commented)")
  const value = host[1]
  assert.ok(
    value === "0.0.0.0" || value === "::" || value === "*",
    `MCP host must bind all interfaces for compose DNS, got ${value}`,
  )
  assert.notEqual(value, "127.0.0.1")
  assert.notEqual(value, "localhost")
})

test("compose does not use APP_HOST as MCP listen override", () => {
  const compose = readRepo("docker-compose.yml")
  const assigned = uncommentedLines(compose).filter((line) => /^\s*APP_HOST\s*:/.test(line))
  assert.equal(assigned.length, 0, `compose must not set APP_HOST, found: ${assigned.join(" | ")}`)
})

test("compose pulls published images and does not build locally", () => {
  const compose = readRepo("docker-compose.yml")
  const active = uncommentedLines(compose).join("\n")
  assert.match(active, /image:\s*ghcr\.io\/cn-asukai\/search-agent/)
  assert.doesNotMatch(active, /^\s*build:/m)
})

test("hanhua prompt requires smartsearch and forbids search-engine SERP fetches", () => {
  const prompt = readRepo("prompts/hanhua-search.md")
  assert.match(prompt, /必须.*smartsearch|smartsearch.*必须/)
  assert.match(prompt, /禁止/)
  for (const needle of ["google", "bing", "baidu", "duckduckgo"]) {
    assert.match(prompt.toLowerCase(), new RegExp(needle), `prompt must mention ${needle} as a forbidden SERP`)
  }
  assert.match(prompt, /搜索结果页/)
})

test("hanhua agent does not allow webfetch as a search stand-in", () => {
  const jsonc = readRepo("opencode.jsonc")
  const permission = /"webfetch"\s*:\s*"([^"]+)"/.exec(jsonc)
  assert.ok(permission, "opencode.jsonc must declare webfetch permission")
  assert.notEqual(permission[1], "allow")
})
