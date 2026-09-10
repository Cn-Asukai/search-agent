/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "./App.tsx"

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

describe("App type radios and recent-task mutex", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        const url = requestUrl(input)
        if (url.includes("/api/health")) {
          return jsonResponse({ status: "ok", service: "search-agent", opencode: { healthy: true } })
        }
        return jsonResponse({ tasks: [] })
      },
    )
  })

  it("exposes type options as radiogroup radios with aria-checked", async () => {
    render(<App />)
    const group = await screen.findByTestId("type-select")
    expect(group.getAttribute("role")).toBe("radiogroup")
    const radios = [...group.querySelectorAll("[role=radio]")]
    expect(radios).toHaveLength(3)
    expect(radios.some((el) => el.getAttribute("aria-checked") === "true")).toBe(true)
    expect(group.querySelector("[aria-pressed]")).toBeNull()
  })

  it("disables recent tasks while a search is running", async () => {
    const hang = Promise.withResolvers<Response>()
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input)
        if (url.includes("/api/health")) {
          return jsonResponse({ status: "ok", service: "search-agent" })
        }
        if ((init?.method ?? "GET") === "POST") {
          return hang.promise
        }
        if (url.includes("/api/search")) {
          return jsonResponse({
            tasks: [{ id: "abc-123", query: "旧任务", type: "novel", status: "done", createdAt: 1 }],
          })
        }
        return jsonResponse({})
      },
    )

    render(<App />)
    const recent = await screen.findByRole("button", { name: /旧任务/ })
    expect(recent).not.toBeDisabled()

    fireEvent.change(screen.getByTestId("query-input"), { target: { value: "転生したら剣でした" } })
    fireEvent.submit(screen.getByTestId("search-form"))

    await waitFor(() => {
      expect(screen.getByTestId("submit-search")).toBeDisabled()
      expect(screen.getByRole("button", { name: /旧任务/ })).toBeDisabled()
    })

    hang.reject(new DOMException("Aborted", "AbortError"))
  })
})
