import { describe, expect, it } from "vitest"
import { decodeUrlForDisplay, decodeUrlsInText, isHttpUrl } from "./displayUrl.ts"

describe("decodeUrlForDisplay", () => {
  it("decodes percent-encoded CJK query strings", () => {
    const encoded =
      "https://www.bing.com/search?q=%22%E7%99%BE%E5%90%88%E7%9B%9B%E5%BC%80%C2%B7%E4%B8%89%E8%A7%92%E5%85%B3%E7%B3%BB%22"
    expect(decodeUrlForDisplay(encoded)).toBe(
      'https://www.bing.com/search?q="百合盛开·三角关系"',
    )
  })

  it("leaves already-readable URLs unchanged", () => {
    const url = "https://bgm.tv/subject/1"
    expect(decodeUrlForDisplay(url)).toBe(url)
  })

  it("does not throw on malformed percent sequences", () => {
    expect(decodeUrlForDisplay("https://example.com/%E4%B")).toBe(
      "https://example.com/%E4%B",
    )
  })
})

describe("decodeUrlsInText", () => {
  it("decodes URLs inside progress messages", () => {
    const message =
      "正在读取网页:https://www.bing.com/search?q=%E8%BD%AC%E7%94%9F%E6%88%90%E5%89%91"
    expect(decodeUrlsInText(message)).toBe("正在读取网页:https://www.bing.com/search?q=转生成剑")
  })

  it("keeps surrounding Chinese text", () => {
    expect(decodeUrlsInText("读取网页完成:https://example.com/a%20b")).toBe(
      "读取网页完成:https://example.com/a b",
    )
  })

  it("decodes nested percent-encoding and keeps trailing punctuation", () => {
    const doubleEncoded = encodeURIComponent("https://example.com/转生")
    expect(decodeUrlForDisplay(doubleEncoded)).toBe("https://example.com/转生")
    expect(decodeUrlsInText("见 https://example.com/a%20b。")).toBe("见 https://example.com/a b。")
    expect(decodeUrlsInText("见 https://example.com/a%20b,")).toBe("见 https://example.com/a b,")
  })
})

describe("isHttpUrl", () => {
  it("accepts absolute http and https", () => {
    expect(isHttpUrl("https://example.com/path")).toBe(true)
    expect(isHttpUrl("http://example.com")).toBe(true)
    expect(isHttpUrl("HTTPS://EXAMPLE.COM/a")).toBe(true)
  })

  it("rejects javascript, data, and protocol-relative", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false)
    expect(isHttpUrl("data:text/html,hi")).toBe(false)
    expect(isHttpUrl("//evil.example/path")).toBe(false)
    expect(isHttpUrl("ftp://example.com/file")).toBe(false)
    expect(isHttpUrl("")).toBe(false)
    expect(isHttpUrl("not a url")).toBe(false)
    expect(isHttpUrl("/relative/path")).toBe(false)
  })
})
