import { Config, Context, Duration, Effect, Layer, Redacted } from "effect"

// ─────────────────────────────────────────────────────────────
// 配置:环境变量 + .env(语义与原 env.ts 一致)
// ─────────────────────────────────────────────────────────────

// .env 加载(Node >= 20.12 原生支持)
try {
  process.loadEnvFile()
} catch {
  // 没有 .env 时静默跳过
}

const intConfig = (name: string, fallback: number): Config.Config<number> =>
  Config.number(name).pipe(
    Config.withDefault(fallback),
    Config.map((n) => (Number.isFinite(n) && n > 0 ? n : fallback)),
  )

const intOrZeroConfig = (name: string, fallback: number): Config.Config<number> =>
  Config.number(name).pipe(
    Config.withDefault(fallback),
    Config.map((n) => (Number.isFinite(n) && n >= 0 ? n : fallback)),
  )

export class AppConfig extends Context.Service<AppConfig, {
  readonly port: number
  readonly host: string
  readonly opencodeHostname: string
  readonly opencodePort: number
  readonly opencodeModel: string | undefined
  readonly opencodeAgent: string
  readonly taskTimeout: Duration.Duration
  readonly maxConcurrency: number
  readonly syncMaxWait: Duration.Duration
  readonly apiAuthKey: Redacted.Redacted<string> | undefined
}>()("AppConfig") {}

/** AppConfig 服务的实例类型 */
export type AppConfigService = Context.Service.Shape<typeof AppConfig>

export const AppConfigLive: Layer.Layer<AppConfig, Config.ConfigError> = Layer.effect(
  AppConfig
)(Effect.gen(function* () {
    const taskTimeoutMs = yield* intConfig("TASK_TIMEOUT_MS", 5 * 60_000)
    const syncMaxWaitMs = yield* intConfig("SYNC_MAX_WAIT_MS", 30 * 60_000)
    const apiAuthKey = yield* Config.option(Config.redacted("API_AUTH_KEY"))
    const opencodeModel = nonempty(yield* Config.option(Config.string("OPENCODE_MODEL")))
    const llmModel = nonempty(yield* Config.option(Config.string("LLM_MODEL")))
    return {
      port: yield* intConfig("PORT", 8787),
      host: yield* Config.string("HOST").pipe(Config.withDefault("0.0.0.0")),
      opencodeHostname: yield* Config.string("OPENCODE_HOSTNAME").pipe(Config.withDefault("127.0.0.1")),
      opencodePort: yield* intOrZeroConfig("OPENCODE_PORT", 0),
      // 自定义网关走 opencode.jsonc 的 custom/default,真正发给上游的是 LLM_MODEL
      opencodeModel: opencodeModel ?? (llmModel ? "custom/default" : undefined),
      opencodeAgent: yield* Config.string("OPENCODE_AGENT").pipe(Config.withDefault("hanhua-search")),
      taskTimeout: Duration.millis(taskTimeoutMs),
      maxConcurrency: yield* intConfig("MAX_CONCURRENCY", 3),
      syncMaxWait: Duration.millis(syncMaxWaitMs),
      apiAuthKey: toUndefined(apiAuthKey),
    }
  }))

function toUndefined<A>(option: { readonly _tag: "Some"; readonly value: A } | { readonly _tag: "None" }): A | undefined {
  return option._tag === "Some" ? option.value : undefined
}

function nonempty(option: { readonly _tag: "Some"; readonly value: string } | { readonly _tag: "None" }): string | undefined {
  const value = toUndefined(option)?.trim()
  return value ? value : undefined
}
