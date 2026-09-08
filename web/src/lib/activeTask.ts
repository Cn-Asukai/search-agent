/** Persist the in-flight search task so a refresh can re-attach SSE. */

export const ACTIVE_TASK_STORAGE_KEY = "search-agent:active-task"
export const ACTIVE_TASK_QUERY = "task"

export function readActiveTaskId(storage: Pick<Storage, "getItem"> | null | undefined = defaultSessionStorage()): string | null {
  if (!storage) return null
  try {
    const value = storage.getItem(ACTIVE_TASK_STORAGE_KEY)?.trim()
    return value ? value : null
  } catch {
    return null
  }
}

export function writeActiveTaskId(
  id: string,
  storage: Pick<Storage, "setItem"> | null | undefined = defaultSessionStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(ACTIVE_TASK_STORAGE_KEY, id)
  } catch {
    // private mode / quota
  }
}

export function clearActiveTaskId(storage: Pick<Storage, "removeItem"> | null | undefined = defaultSessionStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(ACTIVE_TASK_STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function readTaskIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  const value = params.get(ACTIVE_TASK_QUERY)?.trim()
  return value ? value : null
}

export function replaceTaskIdInUrl(id: string | null, loc: Pick<Location, "pathname" | "search" | "hash"> = window.location): void {
  const params = new URLSearchParams(loc.search.startsWith("?") ? loc.search.slice(1) : loc.search)
  if (id) params.set(ACTIVE_TASK_QUERY, id)
  else params.delete(ACTIVE_TASK_QUERY)
  const query = params.toString()
  const next = `${loc.pathname}${query ? `?${query}` : ""}${loc.hash}`
  window.history.replaceState(window.history.state, "", next)
}

function defaultSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage
  } catch {
    return null
  }
}
