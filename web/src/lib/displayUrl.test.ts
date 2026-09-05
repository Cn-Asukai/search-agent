import { describe, expect, it } from "vitest"
import { decodeUrlForDisplay, decodeUrlsInText } from "./displayUrl.ts"

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
})
