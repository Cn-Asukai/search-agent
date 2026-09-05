import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { BookOpen, CircleHelp, Languages, Loader2, Search } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  clearActiveTaskId,
  readActiveTaskId,
  readTaskIdFromSearch,
  replaceTaskIdInUrl,
  writeActiveTaskId,
} from "@/lib/activeTask"
import { decodeUrlForDisplay, decodeUrlsInText } from "@/lib/displayUrl"
import {
  createSearchClient,
  mapTaskToView,
  sourceKindLabels,
  verdictLabels,
  workTypeLabels,
  type HealthInfo,
  type MappedSearchView,
  type ProgressEntry,
  type SearchStreamHandlers,
  type Task,
  type TaskSummary,
  type WorkType,
} from "@/lib/searchClient"

const client = createSearchClient({
  baseUrl: import.meta.env.VITE_API_BASE ?? "",
})

const TYPE_OPTIONS: WorkType[] = ["novel", "manga", "unknown"]

export default function App() {
  const [query, setQuery] = useState("")
  const [type, setType] = useState<WorkType>("unknown")
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressEntry[]>([])
  const [view, setView] = useState<MappedSearchView | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [recent, setRecent] = useState<TaskSummary[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const didResume = useRef(false)

  const refreshHealth = useCallback(async () => {
    try {
      const info = await client.health()
      setHealth(info)
      setHealthError(null)
    } catch (err) {
      setHealth(null)
      setHealthError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await client.listRecent())
    } catch {
      // list is optional evidence; the search path still works
    }
  }, [])

  useEffect(() => {
    void refreshHealth()
    void refreshRecent()
    const timer = window.setInterval(() => {
      void refreshHealth()
      void refreshRecent()
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [refreshHealth, refreshRecent])

  useEffect(() => {
    if (didResume.current) return
    const id = readTaskIdFromSearch(window.location.search) ?? readActiveTaskId()
    if (!id) return
    didResume.current = true
    void followTask(id, "attach")
  }, [])

  function nextSignal(): AbortSignal {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    return controller.signal
  }

  function streamHandlers(): SearchStreamHandlers {
    return {
      signal: nextSignal(),
      onTask(task: Task) {
        writeActiveTaskId(task.id)
        replaceTaskIdInUrl(task.id)
        setQuery(task.query)
        setType(task.type)
        if (task.progress.length) setProgress(task.progress)
      },
      onProgress: (entry) =>
        setProgress((prev) => {
          if (prev.some((item) => item.seq === entry.seq && item.message === entry.message)) return prev
          return [...prev, entry]
        }),
      onResult: (next) => {
        clearActiveTaskId()
        replaceTaskIdInUrl(null)
        setView(next)
      },
      onError: (next) => {
        clearActiveTaskId()
        replaceTaskIdInUrl(null)
        setView(next)
      },
    }
  }

  async function followTask(id: string, mode: "attach" | "open") {
    setFormError(null)
    setRunning(true)
    setView(null)
    try {
      if (mode === "open") {
        const snapshot = await client.getTask(id)
        setQuery(snapshot.query)
        setType(snapshot.type)
        setProgress(snapshot.progress ?? [])
        if (snapshot.status !== "queued" && snapshot.status !== "running") {
          setView(mapTaskToView(snapshot))
          clearActiveTaskId()
          replaceTaskIdInUrl(null)
          return
        }
      }
      const session = await client.attachStream(id, streamHandlers())
      if (session.task) {
        setQuery(session.task.query)
        setType(session.task.type)
      }
      if (session.progress.length) setProgress(session.progress)
      if (session.view) setView(session.view)
    } catch (err) {
      if (isAbortError(err)) return
      clearActiveTaskId()
      replaceTaskIdInUrl(null)
      setView({
        kind: "error",
        taskId: id,
        query,
        type,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRunning(false)
      void refreshRecent()
      void refreshHealth()
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) {
      setFormError("请输入作品名")
      return
    }
    setFormError(null)
    setRunning(true)
    setProgress([])
    setView(null)
    try {
      const session = await client.searchStream({ query: trimmed, type }, streamHandlers())
      if (session.view) setView(session.view)
      else if (session.progress.length) setProgress(session.progress)
    } catch (err) {
      if (isAbortError(err)) return
      clearActiveTaskId()
      replaceTaskIdInUrl(null)
      setView({
        kind: "error",
        taskId: "",
        query: trimmed,
        type,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRunning(false)
      void refreshRecent()
      void refreshHealth()
    }
  }

  async function openRecent(id: string) {
    await followTask(id, "open")
  }

  const healthOk = health?.status === "ok" && !healthError

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Languages className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium tracking-wide text-muted-foreground">search-agent</p>
              <h1 className="font-heading text-xl leading-none">汉化检索</h1>
            </div>
          </div>
          <div data-testid="health-status" className="flex items-center gap-2 text-sm">
            <span
              className={`size-2 rounded-full ${healthOk ? "bg-emerald-500" : "bg-destructive"}`}
              aria-hidden
            />
            <span>
              {healthOk
                ? `服务正常${health?.opencode?.version ? ` · opencode ${health.opencode.version}` : ""}`
                : healthError
                  ? `后端不可达：${healthError}`
                  : `服务 ${health?.status ?? "未知"}`}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>检索作品的中文版本</CardTitle>
              <CardDescription>
                输入作品名，选择类型。服务会联网查找官方中文出版 / 正版引进与民间汉化，并带来源链接。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                data-testid="search-form"
                onSubmit={onSubmit}
                className="flex flex-col gap-4"
              >
                <div className="flex flex-col gap-2">
                  <Label htmlFor="query">作品名</Label>
                  <Input
                    id="query"
                    name="query"
                    data-testid="query-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="例如：転生したら剣でした"
                    autoComplete="off"
                    disabled={running}
                    className="h-10 text-base"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>类型</Label>
                  <div
                    data-testid="type-select"
                    role="group"
                    aria-label="作品类型"
                    className="flex flex-wrap gap-2"
                  >
                    {TYPE_OPTIONS.map((option) => (
                      <Button
                        key={option}
                        type="button"
                        data-testid={`type-${option}`}
                        variant={type === option ? "default" : "outline"}
                        onClick={() => setType(option)}
                        disabled={running}
                      >
                        {option === "novel" ? (
                          <BookOpen />
                        ) : option === "manga" ? (
                          <Languages />
                        ) : (
                          <CircleHelp />
                        )}
                        {workTypeLabels[option]}
                      </Button>
                    ))}
                  </div>
                </div>
                {formError ? (
                  <p className="text-sm text-destructive" role="alert">
                    {formError}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  data-testid="submit-search"
                  disabled={running}
                  size="lg"
                  className="w-fit min-w-32"
                >
                  {running ? <Loader2 className="animate-spin" /> : <Search />}
                  {running ? "检索中…" : "开始检索"}
                </Button>
              </form>
            </CardContent>
          </Card>

          {running || progress.length > 0 ? (
            <ProgressPanel running={running} progress={progress} />
          ) : null}

          <Outcome view={view} />
        </section>

        <aside className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>服务状态</CardTitle>
              <CardDescription>GET /health</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <Row label="服务" value={health?.service ?? "—"} />
              <Row label="状态" value={health?.status ?? healthError ?? "—"} />
              <Row
                label="并发"
                value={
                  health?.runner
                    ? `${health.runner.running ?? 0} 运行 / ${health.runner.queued ?? 0} 排队 / 上限 ${health.runner.limit ?? "—"}`
                    : "—"
                }
              />
              <Row label="任务数" value={health?.tasks?.total != null ? String(health.tasks.total) : "—"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>最近任务</CardTitle>
              <CardDescription>GET /api/search，点击可按 id 回看</CardDescription>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">还没有任务。提交一次检索后会出现在这里。</p>
              ) : (
                <ScrollArea className="h-80">
                  <ul className="flex flex-col gap-2 pr-3">
                    {recent.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          className="w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted"
                          onClick={() => void openRecent(task.id)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">{task.query}</span>
                            <Badge variant="outline">{statusLabel(task.status)}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {workTypeLabels[task.type]} · {task.id.slice(0, 8)}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  )
}

function ProgressPanel({
  running,
  progress,
}: {
  running: boolean
  progress: ProgressEntry[]
}) {
  const endRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    const el = endRef.current
    if (!el) return
    const viewport = el.closest("[data-slot=scroll-area-viewport]")
    if (viewport instanceof HTMLElement) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [progress.length])

  return (
    <Card data-testid="progress-list" className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {running ? <Loader2 className="size-4 animate-spin" /> : null}
          检索进度
        </CardTitle>
        <CardDescription>工具调用与阶段状态会在检索过程中实时出现。</CardDescription>
      </CardHeader>
      <CardContent>
        {progress.length === 0 ? (
          <p className="text-sm text-muted-foreground">已提交，等待服务推送进度…</p>
        ) : (
          <ScrollArea className="h-64 overflow-hidden">
            <ol className="flex flex-col gap-2 pr-3">
              {progress.map((entry, index) => (
                <li
                  key={`${entry.seq}-${index}`}
                  ref={index === progress.length - 1 ? endRef : undefined}
                  className="rounded-lg border bg-muted/40 px-3 py-2 text-sm break-all"
                >
                  <span className="mr-2 text-xs text-muted-foreground">
                    {entry.kind === "tool" ? "工具" : entry.kind === "text" ? "文本" : "状态"}
                  </span>
                  {decodeUrlsInText(entry.message)}
                  {entry.detail ? (
                    <p className="mt-1 text-xs text-muted-foreground break-all">
                      {decodeUrlsInText(entry.detail)}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError"
}

function statusLabel(status: TaskSummary["status"]): string {
  switch (status) {
    case "queued":
      return "排队"
    case "running":
      return "进行中"
    case "done":
      return "完成"
    case "error":
      return "失败"
  }
}

function Outcome({ view }: { view: MappedSearchView | null }) {
  if (!view) {
    return (
      <Card data-testid="search-empty">
        <CardHeader>
          <CardTitle>结果</CardTitle>
          <CardDescription>提交后会在这里显示判定、官方中文、民间汉化、来源与摘要。</CardDescription>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed text-muted-foreground">
          <p>判定（verdict）：official / fan / both / none / uncertain。</p>
          <p className="mt-2">检索通常需要数十秒到几分钟，进度事件会先到达。</p>
        </CardContent>
      </Card>
    )
  }

  if (view.kind === "error") {
    return (
      <Alert variant="destructive" data-testid="search-error">
        <AlertTitle>检索失败</AlertTitle>
        <AlertDescription>{view.error ?? "未知错误"}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Card data-testid="search-result">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>检索结果</CardTitle>
          {view.verdict ? <Badge>{verdictLabels[view.verdict]}</Badge> : null}
          {view.confidence ? <Badge variant="secondary">置信度 {view.confidence}</Badge> : null}
        </div>
        <CardDescription>
          {view.work?.original_title ?? view.query}
          {view.work?.chinese_title ? ` · ${view.work.chinese_title}` : ""}
          {view.work?.author ? ` · ${view.work.author}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {view.summary ? (
          <p data-testid="result-summary" className="text-sm leading-relaxed">
            {view.summary}
          </p>
        ) : null}
        <Separator />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">官方中文</h3>
            {view.official?.exists ? (
              <ul className="space-y-1 text-sm">
                {view.official.publisher ? <li>出版社：{view.official.publisher}</li> : null}
                {view.official.regions?.length ? <li>地区：{view.official.regions.join("、")}</li> : null}
                {view.official.evidence ? (
                  <li className="text-muted-foreground">{view.official.evidence}</li>
                ) : null}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">未发现官方中文</p>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">民间汉化</h3>
            {view.fan?.exists && view.fan.translations.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {view.fan.translations.map((item) => (
                  <li key={`${item.source_url}-${item.group ?? ""}`}>
                    <span>{item.group ?? "未具名汉化组"}</span>
                    <span className="text-muted-foreground"> · {item.status}</span>
                    <div>
                      <a
                        className="text-primary break-all underline-offset-4 hover:underline"
                        href={item.source_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {decodeUrlForDisplay(item.source_url)}
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">未发现民间汉化</p>
            )}
          </div>
        </div>
        <Separator />
        <div>
          <h3 className="mb-2 text-sm font-medium">来源</h3>
          {view.sources && view.sources.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {view.sources.map((source) => (
                <li key={source.url} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{sourceKindLabels[source.kind] ?? source.kind}</Badge>
                  <a
                    className="text-primary break-all underline-offset-4 hover:underline"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.title ?? source.site ?? decodeUrlForDisplay(source.url)}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">无来源链接</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}


