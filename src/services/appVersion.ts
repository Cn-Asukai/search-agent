import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")

function describeGitTag(): string | null {
  try {
    const out = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim()
    return out || null
  } catch {
    return null
  }
}

export function resolveAppVersion(
  envValue: string | undefined,
  describe: () => string | null = describeGitTag,
): string {
  const trimmed = envValue?.trim()
  if (trimmed) return trimmed
  return describe() ?? "unknown"
}

export function readRevision(envValue: string | undefined): string | null {
  const trimmed = envValue?.trim()
  if (!trimmed) return null
  return trimmed
}
