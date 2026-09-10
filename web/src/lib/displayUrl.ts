/** Percent-decode a URL (or URL-shaped string) for human-readable display. */
export function decodeUrlForDisplay(url: string): string {
  let current = url
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current)
      if (next === current) break
      current = next
    } catch {
      break
    }
  }
  return current
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')]+/gi

/** Decode percent-encoded http(s) URLs embedded in progress / result text. */
export function decodeUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trailing = match.match(/[),.;，。]+$/)
    const core = trailing ? match.slice(0, -trailing[0].length) : match
    return decodeUrlForDisplay(core) + (trailing?.[0] ?? "")
  })
}

/**
 * True only for absolute http(s) URLs. Rejects javascript:, data:,
 * protocol-relative, and anything URL() cannot parse as http/https.
 */
export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith("//")) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}
