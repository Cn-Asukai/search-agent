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

test("websearch token contract is enabled in yaml, compose, and opencode", () => {
  const yaml = uncommentedLines(readRepo("websearch.config.yaml")).join("\n")
  assert.match(yaml, /^\s*auth_token:/m)

  const compose = uncommentedLines(readRepo("docker-compose.yml")).join("\n")
  assert.match(compose, /WEBSEARCH_TOKEN:\s*\$\{WEBSEARCH_TOKEN/)

  const jsonc = uncommentedLines(readRepo("opencode.jsonc")).join("\n")
  assert.match(jsonc, /Authorization["']?\s*:\s*["']Bearer/)
  assert.match(jsonc, /WEBSEARCH_TOKEN/)
})

test("docs require compose-only yaml and three-way websearch token", () => {
  const readme = readRepo("README.md")
  assert.match(readme, /禁止当裸金属/)
  assert.match(readme, /WEBSEARCH_TOKEN/)
  assert.match(readme, /三处/)
})

test("compose binds agent HTTP to loopback", () => {
  const compose = uncommentedLines(readRepo("docker-compose.yml")).join("\n")
  assert.match(compose, /127\.0\.0\.1:\$\{AGENT_PORT:-8787\}:8787/)
})

test("production image compiles with tsc and runs node dist", () => {
  const dockerfile = uncommentedLines(readRepo("Dockerfile")).join("\n")
  assert.match(dockerfile, /tsc -p tsconfig\.build\.json/)
  assert.match(dockerfile, /npm ci --omit=dev/)
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/)
})

test("runtime entrypoint chowns bind mounts then drops to node", () => {
  const dockerfile = uncommentedLines(readRepo("Dockerfile")).join("\n")
  assert.match(dockerfile, /ENTRYPOINT \["docker-entrypoint.sh"\]/)
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/)
  assert.doesNotMatch(dockerfile, /\bUSER node\b/)
  const entry = readRepo("docker-entrypoint.sh")
  assert.match(entry, /setpriv --reuid=node --regid=node --init-groups/)
  assert.match(entry, /\/home\/node\/\.local\/share\/opencode/)
  assert.match(entry, /chown node:node \/home\/node\/data/)
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

test("compose persists sqlite on local data directory", () => {
  const compose = readRepo("docker-compose.yml")
  const active = uncommentedLines(compose).join("\n")
  assert.match(active, /\.\/data:\/home\/node\/data/)
  assert.match(active, /\.\/data\/opencode:\/home\/node\/\.local\/share\/opencode/)
  assert.match(active, /\.\/data\/websearch:\/app\/data/)
  assert.match(active, /SQLITE_PATH:\s*\/home\/node\/data\/search-agent\.sqlite/)
  assert.doesNotMatch(active, /(?:^|\s)(?:opencode-data|agent-data|websearch-cache):/)
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

test("runtime Dockerfile injects GIT_REVISION and GIT_VERSION", () => {
  const dockerfile = uncommentedLines(readRepo("Dockerfile")).join("\n")
  assert.match(dockerfile, /ARG GIT_REVISION/)
  assert.match(dockerfile, /ENV GIT_REVISION/)
  assert.match(dockerfile, /ARG GIT_VERSION/)
  assert.match(dockerfile, /ENV GIT_VERSION/)
})

test("publish workflow passes github.sha as GIT_REVISION and tag as GIT_VERSION", () => {
  const workflow = readRepo(".github/workflows/publish-docker.yml")
  assert.match(workflow, /GIT_REVISION=\$\{\{\s*github\.sha\s*\}\}/)
  assert.match(workflow, /GIT_VERSION=\$\{\{\s*github\.ref_name\s*\}\}/)
})

test("dev compose forwards git identity as image build args", () => {
  const compose = readRepo("docker-compose.dev.yml")
  assert.match(compose, /GIT_REVISION:\s*\$\{GIT_REVISION/)
  assert.match(compose, /GIT_VERSION:\s*\$\{GIT_VERSION/)
})

test("PR test workflow triggers on pull_request opened/synchronize/reopened", () => {
  const workflow = readRepo(".github/workflows/test.yml")
  assert.match(workflow, /^on:\s*$/m)
  assert.match(workflow, /^\s*pull_request:\s*$/m)
  assert.match(workflow, /types:\s*\[opened,\s*synchronize,\s*reopened\]/)
  assert.doesNotMatch(workflow, /pull_request_target:/)
})

test("PR test workflow checks out the PR, installs Node 22.16+, typechecks, and runs all tests", () => {
  const workflow = readRepo(".github/workflows/test.yml")
  const active = uncommentedLines(workflow).join("\n")
  assert.match(active, /persist-credentials:\s*false/)
  assert.match(active, /node-version:\s*"22\.16"/)
  assert.match(active, /npm ci/)
  assert.match(active, /npm ci --prefix web/)
  assert.match(active, /npm run typecheck/)
  assert.match(active, /npm test/)
  assert.match(active, /npm run web:test/)
  assert.doesNotMatch(active, /secrets\./)
})
