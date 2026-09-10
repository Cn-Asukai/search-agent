const GENERIC_TRY = /^An error occurred in Effect\.try(?:Promise)?$/

export function formatError(err: unknown, depth = 0): string {
  if (depth > 6) return ""
  if (err instanceof Error) {
    const nested = err.cause !== undefined ? formatError(err.cause, depth + 1) : ""
    if (!err.message || GENERIC_TRY.test(err.message)) return nested || err.message
    if (nested && !err.message.includes(nested)) return `${err.message}: ${nested}`
    return err.message
  }
  if (err === undefined || err === null) return ""
  return String(err)
}

export function logInfo(scope: string, message: string): void {
  console.log(`[${scope}] ${message}`)
}

export function logWarn(scope: string, message: string, err?: unknown): void {
  if (err === undefined) console.warn(`[${scope}] ${message}`)
  else console.warn(`[${scope}] ${message}: ${formatError(err)}`)
}

export function logError(scope: string, message: string, err?: unknown): void {
  if (err === undefined) console.error(`[${scope}] ${message}`)
  else console.error(`[${scope}] ${message}: ${formatError(err)}`)
}
