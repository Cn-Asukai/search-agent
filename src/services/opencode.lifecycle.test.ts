import assert from "node:assert/strict"
import { test } from "node:test"
import { Duration, Effect, Layer } from "effect"
import { AppConfig } from "../env.js"
import { makeOpenCodeLive, OpenCode } from "./opencode.js"

function configLive() {
  return Layer.succeed(
    AppConfig,
    AppConfig.of({
      port: 8787,
      host: "127.0.0.1",
      opencodeHostname: "127.0.0.1",
      opencodePort: 0,
      opencodeModel: undefined,
      opencodeAgent: "hanhua-search",
      taskTimeout: Duration.millis(60_000),
      maxConcurrency: 2,
      syncMaxWait: Duration.millis(60_000),
      apiAuthKey: undefined,
      sqlitePath: ":memory:",
    }),
  )
}

test("OpenCodeLive closes the embedded server when the layer scope ends", async () => {
  let spawnCount = 0
  let closeCount = 0
  const layer = makeOpenCodeLive(async (options = {}) => {
    spawnCount += 1
    assert.equal(options.hostname, "127.0.0.1")
    assert.equal(options.port, 0)
    assert.equal(options.timeout, 60_000)
    return {
      url: "http://127.0.0.1:4096",
      close() {
        closeCount += 1
      },
    }
  }).pipe(Layer.provide(configLive()))

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode = yield* OpenCode
        assert.equal(opencode.url, "http://127.0.0.1:4096")
        assert.equal(spawnCount, 1)
        assert.equal(closeCount, 0)
      }).pipe(Effect.provide(layer)),
    ),
  )

  assert.equal(spawnCount, 1)
  assert.equal(closeCount, 1)
})
