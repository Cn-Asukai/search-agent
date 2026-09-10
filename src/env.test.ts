import assert from "node:assert/strict"
import { test } from "node:test"
import { ConfigProvider, Duration, Effect, Redacted } from "effect"
import { AppConfig, AppConfigLive } from "./env.js"

const CONFIG_KEYS = [
  "PORT",
  "HOST",
  "OPENCODE_HOSTNAME",
  "OPENCODE_PORT",
  "OPENCODE_MODEL",
  "OPENCODE_AGENT",
  "LLM_MODEL",
  "TASK_TIMEOUT_MS",
  "MAX_CONCURRENCY",
  "SYNC_MAX_WAIT_MS",
  "API_AUTH_KEY",
  "SQLITE_PATH",
] as const

async function withEnv<A>(
  env: Record<string, string | undefined>,
  run: () => Promise<A>,
): Promise<A> {
  const saved: Record<string, string | undefined> = {}
  for (const key of CONFIG_KEYS) {
    saved[key] = process.env[key]
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      const value = env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    } else {
      delete process.env[key]
    }
  }
  try {
    return await run()
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function loadConfig() {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* AppConfig
    }).pipe(
      Effect.provide(AppConfigLive),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
    ),
  )
}

test("AppConfig uses documented defaults when env vars are absent", async () => {
  await withEnv({}, async () => {
    const config = await loadConfig()
    assert.equal(config.port, 8787)
    assert.equal(config.host, "0.0.0.0")
    assert.equal(config.opencodeHostname, "127.0.0.1")
    assert.equal(config.opencodePort, 0)
    assert.equal(config.opencodeModel, undefined)
    assert.equal(config.opencodeAgent, "hanhua-search")
    assert.equal(Duration.toMillis(config.taskTimeout), 10 * 60_000)
    assert.equal(config.maxConcurrency, 3)
    assert.equal(Duration.toMillis(config.syncMaxWait), 30 * 60_000)
    assert.equal(config.apiAuthKey, undefined)
    assert.equal(config.sqlitePath, "./data/search-agent.sqlite")
  })
})

test("AppConfig reads valid integers and strings from process.env", async () => {
  await withEnv(
    {
      PORT: "9999",
      HOST: "127.0.0.1",
      OPENCODE_HOSTNAME: "10.0.0.1",
      OPENCODE_PORT: "4096",
      OPENCODE_MODEL: "custom/default",
      OPENCODE_AGENT: "other-agent",
      TASK_TIMEOUT_MS: "120000",
      MAX_CONCURRENCY: "5",
      SYNC_MAX_WAIT_MS: "60000",
      API_AUTH_KEY: "test-key",
      SQLITE_PATH: ":memory:",
    },
    async () => {
      const config = await loadConfig()
      assert.equal(config.port, 9999)
      assert.equal(config.host, "127.0.0.1")
      assert.equal(config.opencodeHostname, "10.0.0.1")
      assert.equal(config.opencodePort, 4096)
      assert.equal(config.opencodeModel, "custom/default")
      assert.equal(config.opencodeAgent, "other-agent")
      assert.equal(Duration.toMillis(config.taskTimeout), 120_000)
      assert.equal(config.maxConcurrency, 5)
      assert.equal(Duration.toMillis(config.syncMaxWait), 60_000)
      assert.ok(config.apiAuthKey)
      assert.equal(Redacted.value(config.apiAuthKey), "test-key")
      assert.equal(config.sqlitePath, ":memory:")
    },
  )
})

test("AppConfig falls back when integers are illegal or not positive", async () => {
  await withEnv(
    {
      PORT: "abc",
      OPENCODE_PORT: "nope",
      TASK_TIMEOUT_MS: "-1",
      MAX_CONCURRENCY: "0",
      SYNC_MAX_WAIT_MS: "NaN",
    },
    async () => {
      const config = await loadConfig()
      assert.equal(config.port, 8787)
      assert.equal(config.opencodePort, 0)
      assert.equal(Duration.toMillis(config.taskTimeout), 10 * 60_000)
      assert.equal(config.maxConcurrency, 3)
      assert.equal(Duration.toMillis(config.syncMaxWait), 30 * 60_000)
    },
  )
})

test("AppConfig maps LLM_MODEL to custom/default unless OPENCODE_MODEL is set", async () => {
  await withEnv({ LLM_MODEL: "deepseek-chat" }, async () => {
    const config = await loadConfig()
    assert.equal(config.opencodeModel, "custom/default")
  })
  await withEnv(
    { LLM_MODEL: "deepseek-chat", OPENCODE_MODEL: "openai/gpt-4o" },
    async () => {
      const config = await loadConfig()
      assert.equal(config.opencodeModel, "openai/gpt-4o")
    },
  )
  await withEnv({ OPENCODE_MODEL: "   ", LLM_MODEL: "   " }, async () => {
    const config = await loadConfig()
    assert.equal(config.opencodeModel, undefined)
  })
})
