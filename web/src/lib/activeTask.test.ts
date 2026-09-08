import { describe, expect, it } from "vitest"
import {
  ACTIVE_TASK_STORAGE_KEY,
  clearActiveTaskId,
  readActiveTaskId,
  readTaskIdFromSearch,
  writeActiveTaskId,
} from "./activeTask.ts"

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = { ...initial }
  return {
    get length() {
      return Object.keys(data).length
    },
    clear() {
      for (const key of Object.keys(data)) delete data[key]
    },
    getItem(key) {
      return data[key] ?? null
    },
    key(index) {
      return Object.keys(data)[index] ?? null
    },
    removeItem(key) {
      delete data[key]
    },
    setItem(key, value) {
      data[key] = value
    },
  }
}

describe("active task persistence", () => {
  it("round-trips an id through storage", () => {
    const storage = memoryStorage()
    expect(readActiveTaskId(storage)).toBeNull()
    writeActiveTaskId("abc-123", storage)
    expect(storage.getItem(ACTIVE_TASK_STORAGE_KEY)).toBe("abc-123")
    expect(readActiveTaskId(storage)).toBe("abc-123")
    clearActiveTaskId(storage)
    expect(readActiveTaskId(storage)).toBeNull()
  })

  it("reads task id from the query string", () => {
    expect(readTaskIdFromSearch("?task=from-url")).toBe("from-url")
    expect(readTaskIdFromSearch("task=from-url&x=1")).toBe("from-url")
    expect(readTaskIdFromSearch("")).toBeNull()
    expect(readTaskIdFromSearch("?q=foo")).toBeNull()
  })
})
