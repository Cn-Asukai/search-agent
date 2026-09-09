import { readFileSync } from "node:fs"

export function readAppVersion(packageJsonText: string): string {
  try {
    const parsed: unknown = JSON.parse(packageJsonText)
    if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
      const version = parsed.version
      if (typeof version === "string") {
        const trimmed = version.trim()
        if (trimmed !== "") return trimmed
      }
    }
  } catch {
    // invalid JSON → unknown
  }
  return "unknown"
}

export function loadAppVersion(packageJsonPath: string): string {
  try {
    return readAppVersion(readFileSync(packageJsonPath, "utf8"))
  } catch {
    return "unknown"
  }
}

export function readRevision(envValue: string | undefined): string | null {
  const trimmed = envValue?.trim()
  if (!trimmed) return null
  return trimmed
}
