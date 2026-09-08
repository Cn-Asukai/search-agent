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
