/**
 * Host half of dsh-usage-dashboard.
 *
 * Responsibilities:
 *   1) After mount, asynchronously scan ALL session logs and fold token
 *      usage into five dimensions: grand totals, per-local-day buckets,
 *      per-hour buckets, per-model buckets, and per-session buckets
 *      (with the session title from `session/title` events).
 *   2) RAW-first scan: walk ~/.dsh/sessions, decompress every
 *      session.jsonl.zstd (multi-frame zstd via the `zstd` CLI; Node's zlib
 *      only surfaces the first frame) and fold assistant/message usage
 *      directly — immune to the harness interpreter's unknown-event refusals
 *      (the same approach dsh-usage-widget verified byte-exact against an
 *      independent log audit).
 *   3) Harness fallback: when RAW decode fails (e.g. a still-writing trailing
 *      frame), fall back to sessionQuery.readSession / persistence.readFrom.
 *   4) ctx.on('session/event') live incremental fold with a per-session
 *      maxSeq watermark for dedupe; live `session/title` events update the
 *      session display name.
 *   5) Periodic self-healing re-scan every 60s, guarded by a reentrancy lock
 *      so scans never overlap (watermark keeps re-folds idempotent).
 *   6) GET /usage/api/dashboard?range=7d|24h|all&hours=24&top=8 — JSON API
 *      for the settings-page dashboard. The route is read-only aggregate
 *      stats, fenced to loopback Hosts (DNS-rebinding / cross-site defense),
 *      like the DSH sidebar routes.
 *
 * Data source (the project's existing token records): assistant/message
 * events whose data.usage.inputTokens is a number; the model attribution
 * comes from data.message.source.model; the session title from
 * session/title events' data.title. total = input + output + cacheRead +
 * cacheWrite (no reasoning).
 *
 * Runtime imports: node builtins only — every DSH service arrives through the
 * cordis inject list.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-usage-dashboard'

/** Services required before mounting. */
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'timer']

const HOUR_MS = 3600_000
const DAY_MS = 86400_000

/** One aggregate counter set. */
function newAgg() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0,
  }
}

/** Local-midnight epoch ms for a timestamp (avoids UTC drift). */
function localMidnight(timeMs: number): number {
  const d = new Date(timeMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Local hour start (minute/second/ms zeroed) epoch ms. */
function localHourStart(timeMs: number): number {
  const d = new Date(timeMs)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

// ============================================================
// Raw-log recovery helpers (same path as dsh-usage-widget)
// ============================================================
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/** Decompress a session log. Session logs are CONCATENATED zstd frames (one
 *  frame per append); Node's zlib only surfaces the first frame, so use the
 *  `zstd` CLI which handles concatenated frames natively. */
function zstdToText(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('zstd', ['-d', '-c', filePath], { maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Parse an NDJSON log body into events (malformed lines are skipped). */
function parseLogLines(text: string): any[] {
  const events: any[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t)) } catch { /* skip */ }
  }
  return events
}

/** Recursively discover every session log under the sessions root (depth ≤3):
 *  map sessionId -> log path. Also locates bare-id and encoded-workspace dirs. */
function findSessionLogs(root: string, depth: number, out: Map<string, string>): void {
  if (depth > 3) return
  let entries: string[]
  try { entries = readdirSync(root) } catch { return }
  for (const entry of entries) {
    const p = join(root, entry)
    let st: any
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      findSessionLogs(p, depth + 1, out)
    } else if (entry === 'session.jsonl.zstd') {
      const id = root.split('/').pop() || ''
      if (id) out.set(id, p)
    }
  }
}

/** Fold one usage record into one aggregate. */
function ink(agg: ReturnType<typeof newAgg>, u: Record<string, unknown>): void {
  const input = (u.inputTokens as number) || 0
  const output = (u.outputTokens as number) || 0
  const cacheRead = (u.cacheReadTokens as number) || 0
  const cacheWrite = (u.cacheWriteTokens as number) || 0
  const reasoning = (u.reasoningTokens as number) || 0
  agg.input += input
  agg.output += output
  agg.cacheRead += cacheRead
  agg.cacheWrite += cacheWrite
  agg.reasoning += reasoning
  agg.total += input + output + cacheRead + cacheWrite
  agg.calls += 1
}

/** Whether an event carries a usable token-usage record. */
function usable(event: any): boolean {
  return !!event && event.type === 'assistant/message' &&
    !!event.data && !!event.data.usage &&
    typeof event.data.usage.inputTokens === 'number'
}

/** The model attribution of an assistant/message event. */
function modelOf(event: any): string {
  const src = event?.data?.message?.source
  if (src && typeof src.model === 'string' && src.model) return src.model
  const direct = event?.data?.model
  if (typeof direct === 'string' && direct) return direct
  return 'unknown'
}

const msgOf = (e: unknown): string =>
  (e && typeof e === 'object' && (e as any).message) ? String((e as any).message) : String(e)
const shortOf = (id: string): string =>
  typeof id === 'string' && id.length > 12 ? id.slice(0, 12) + '…' : String(id)

// ============================================================
// HTTP helpers
// ============================================================
function readQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://dsh.internal').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** DNS-rebinding / cross-site defense for the JSON API: only loopback
 *  authorities may call it (the DSH web server binds loopback by default). */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  let hostname = hostHeader
  const at = hostHeader.lastIndexOf('@')
  if (at !== -1) hostname = hostHeader.slice(at + 1)
  if (hostname.startsWith('[')) {
    // [::1]:port or [::1]
    const end = hostname.indexOf(']')
    return end !== -1 && hostname.slice(1, end) === '::1'
  }
  if (hostname === '::1') return true
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && hostname.indexOf(']') === -1 && hostname.indexOf(':') === colon) {
    hostname = hostname.slice(0, colon)
  }
  if (hostname === 'localhost') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function apply(ctx: any): void {
  // ---- in-memory aggregate store ----
  const store = {
    sessions: new Map<string, any>(), // sessionId -> { daily: Map, allAgg, maxSeq, title?, cwd?, lastAt }
    allAgg: newAgg(),
    allDaily: new Map<number, ReturnType<typeof newAgg>>(),
    allHourly: new Map<number, ReturnType<typeof newAgg>>(),
    byModel: new Map<string, ReturnType<typeof newAgg>>(),
    scanning: false,
    running: false,               // 扫描防重入锁
    scans: 0,
    failed: 0,                    // 本轮 RAW 与 harness 均无法读取的会话数
    rawSessions: 0,               // 通过 RAW 日志（zstd 直接解析）折叠的会话数
    harnessSessions: 0,           // 通过 harness 解释器兜底折叠的会话数
    foldedEvents: 0,              // 已折叠的用量事件总数（审计用）
    dedupSkipped: 0,              // 水位去重跳过的事件数（审计用）
    lastError: null as string | null, // 最近一次会话级失败详情（诊断用）
    scanError: null as string | null, // 灾难级错误（会话清单获取失败等）
    lastScanAt: 0,
  }

  function dayAgg(map: Map<number, any>, day: number) {
    let a = map.get(day)
    if (!a) { a = newAgg(); map.set(day, a) }
    return a
  }

  function ensureSession(id: string) {
    let info = store.sessions.get(id)
    if (!info) {
      info = { daily: new Map(), allAgg: newAgg(), maxSeq: -1, title: undefined, cwd: undefined, lastAt: 0 }
      store.sessions.set(id, info)
    }
    return info
  }

  /** Note the session display title (from session/title events). */
  function noteTitle(id: string, title: unknown): void {
    if (typeof title !== 'string' || title === '') return
    const info = ensureSession(id)
    if (info.title === undefined) info.title = title
  }

  /** Fold one usage record into every dimension. */
  function foldUsage(id: string, timeMs: number, u: Record<string, unknown>, model: string): void {
    const info = ensureSession(id)
    const day = localMidnight(timeMs)
    ink(dayAgg(info.daily, day), u)
    ink(info.allAgg, u)
    ink(dayAgg(store.allDaily, day), u)
    ink(dayAgg(store.allHourly, localHourStart(timeMs)), u)
    ink(store.allAgg, u)
    ink(dayAgg(store.byModel, model), u)
    if (typeof timeMs === 'number' && timeMs > info.lastAt) info.lastAt = timeMs
  }

  /** Fold a batch of log events for one session (idempotent via maxSeq). */
  function foldSessionEvents(id: string, events: any[]): void {
    const info = ensureSession(id)
    if (!Array.isArray(events)) return
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'session/title') { noteTitle(id, ev.data?.title); continue }
      if (ev.type === 'session' && typeof ev.cwd === 'string' && !info.cwd) info.cwd = ev.cwd
      if (!usable(ev)) continue
      if (typeof ev.seq === 'number' && ev.seq <= info.maxSeq) { store.dedupSkipped += 1; continue }
      foldUsage(id, ev.time, ev.data.usage, modelOf(ev))
      store.foldedEvents += 1
      if (typeof ev.seq === 'number') info.maxSeq = Math.max(info.maxSeq, ev.seq)
    }
  }

  async function scanOnce(options: { initial?: boolean }): Promise<void> {
    const initial = !!(options && options.initial)
    if (initial) store.scanning = true
    // 防重入：扫描不重叠（初始扫描与 60s 自愈重扫互斥）
    if (store.running) return
    store.running = true
    store.scans += 1
    store.lastScanAt = Date.now()
    // 每轮扫描独立计数；全部成功则清除历史错误（自愈）
    store.failed = 0
    store.rawSessions = 0
    store.harnessSessions = 0
    try {
      const query = ctx.get('sessionQuery')
      const persist = ctx.get('sessionPersistence')

      // 1) session id 全集 = 磁盘上的原始日志 ∪ harness 会话清单。
      const logPaths = new Map<string, string>()
      findSessionLogs(SESSIONS_ROOT, 0, logPaths)
      const ids = new Set<string>(logPaths.keys())

      let records: any[] = []
      if (query) {
        try {
          records = await query.listSessions()
          if (!Array.isArray(records)) records = []
        } catch (e) {
          store.scanError = 'listSessions: ' + msgOf(e)
          records = []
        }
      }
      if ((!Array.isArray(records) || records.length === 0) && persist) {
        try {
          const headers = await persist.list()
          records = Array.isArray(headers) ? headers.map((h: any) => ({ header: h })) : []
          if (records.length > 0) store.scanError = null
        } catch (e) {
          store.scanError = 'persistence.list: ' + msgOf(e)
        }
      }
      const idOf = (rec: any): string | undefined => {
        if (!rec) return undefined
        if (rec.header && typeof rec.header.id === 'string') return rec.header.id
        if (typeof rec.id === 'string') return rec.id
        return undefined
      }
      for (const rec of records) {
        const id = idOf(rec)
        if (id) ids.add(id)
      }
      const idList: string[] = [...ids]

      // 2) per-session: RAW first（完整、不受解释器限制），失败则 harness 兜底
      let i = 0
      async function worker(): Promise<void> {
        while (i < idList.length) {
          const id = idList[i]; i += 1
          try {
            const rawPath = logPaths.get(id)
            if (rawPath) {
              try {
                const text = await zstdToText(rawPath)
                foldSessionEvents(id, parseLogLines(text))
                store.rawSessions += 1
                continue
              } catch (e) {
                store.lastError = 'raw ' + shortOf(id) + ': ' + msgOf(e)
              }
            }
            // harness fallback: sessionQuery.readSession / persistence.readFrom
            let events: any[] | null = null
            if (query) {
              try {
                const snap = await query.readSession(id)
                events = snap && Array.isArray(snap.events) ? snap.events : null
              } catch (e) {
                store.lastError = 'readSession ' + shortOf(id) + ': ' + msgOf(e)
                events = null
              }
            }
            if (events === null && persist) {
              try {
                const r = await persist.readFrom(id, 0)
                events = r && Array.isArray(r.events) ? r.events : []
              } catch (e) {
                store.lastError = 'readFrom ' + shortOf(id) + ': ' + msgOf(e)
                events = null
              }
            }
            if (events && events.length) {
              foldSessionEvents(id, events)
              store.harnessSessions += 1
            } else if (events === null) {
              // RAW 失败 且 harness 也报错 → 才算失败；空会话（events=[]）不算
              store.failed += 1
            }
          } catch (e) {
            store.lastError = 'session ' + shortOf(id) + ': ' + msgOf(e)
            store.failed += 1
          }
        }
      }

      const n = Math.max(1, Math.min(4, idList.length || 1))
      const workers: Promise<void>[] = []
      for (let k = 0; k < n; k += 1) workers.push(worker())
      await Promise.all(workers.map((w) => w.catch((e) => { store.lastError = 'worker: ' + msgOf(e); store.failed += 1 })))
    } finally {
      // 本轮无失败会话 → 清除历史标记（自愈：日志可读性恢复后自动消失）
      if (store.failed === 0) { store.lastError = null; store.scanError = null }
      if (initial) store.scanning = false
      store.running = false
    }
  }

  // ---- live listener first (no events missed during the initial scan) ----
  ctx.on('session/event', (session: any, event: any) => {
    const id = session && typeof session.id === 'string' ? session.id : undefined
    if (!id) return
    if (!event || typeof event !== 'object') return
    if (event.type === 'session/title') { noteTitle(id, event.data?.title); return }
    if (!usable(event)) return
    const info = ensureSession(id)
    if (typeof event.seq === 'number' && event.seq <= info.maxSeq) { store.dedupSkipped += 1; return }
    foldUsage(id, event.time, event.data.usage, modelOf(event))
    store.foldedEvents += 1
    if (typeof event.seq === 'number') info.maxSeq = Math.max(info.maxSeq, event.seq)
  })

  scanOnce({ initial: true }).catch((e) => console.error('[usage-dashboard] initial scan failed', e))

  // ---- periodic self-healing re-scan (60s) ----
  const timer = ctx.get('timer')
  if (timer && typeof timer.interval === 'function') {
    timer.interval(() => {
      scanOnce({ initial: false }).catch((e) => console.error('[usage-dashboard] sweep failed', e))
    }, 60000)
  }

  // ---- dashboard building ----
  /** Fill zero buckets for the last `days` local days (oldest → newest). */
  function dailySeries(days: number): any[] {
    const today = localMidnight(Date.now())
    const out: any[] = []
    for (let i = days - 1; i >= 0; i -= 1) {
      const t = today - i * DAY_MS
      const agg = store.allDaily.get(t)
      out.push(agg ? {
        t, input: agg.input, output: agg.output, cacheRead: agg.cacheRead,
        cacheWrite: agg.cacheWrite, reasoning: agg.reasoning, total: agg.total, calls: agg.calls,
      } : {
        t, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0,
      })
    }
    return out
  }

  /** Fill zero buckets for the last `hours` local hours (oldest → newest). */
  function hourlySeries(hours: number): any[] {
    const now = localHourStart(Date.now())
    const out: any[] = []
    for (let i = hours - 1; i >= 0; i -= 1) {
      const t = now - i * HOUR_MS
      const agg = store.allHourly.get(t)
      out.push(agg ? {
        t, input: agg.input, output: agg.output, cacheRead: agg.cacheRead,
        cacheWrite: agg.cacheWrite, reasoning: agg.reasoning, total: agg.total, calls: agg.calls,
      } : {
        t, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0,
      })
    }
    return out
  }

  function usageOf(agg: any) {
    return {
      input: agg.input, output: agg.output, cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite, reasoning: agg.reasoning, total: agg.total, calls: agg.calls,
    }
  }

  function dashboard(range: string, hours: number, top: number): any {
    const days = range === 'all' ? 0 : range === '30d' ? 30 : 7
    // 全部历史按自然日（含今天）返回；30d/7d 零填充最近 N 天
    const daily = days === 0
      ? [...store.allDaily.entries()].sort((a, b) => a[0] - b[0]).map(([t, agg]) => ({ t, ...usageOf(agg) }))
      : dailySeries(days)

    // 按模型分布：total 降序
    const byModel = [...store.byModel.entries()]
      .map(([model, agg]) => ({ model, ...usageOf(agg) }))
      .sort((a, b) => b.total - a.total)

    // 按会话分布：total 降序，附标题/工作目录/最近活跃时间
    const bySession = [...store.sessions.entries()]
      .filter(([, info]) => info.allAgg.calls > 0)
      .map(([id, info]) => ({
        id,
        title: info.title ?? undefined,
        cwd: info.cwd ?? undefined,
        lastAt: info.lastAt || 0,
        ...usageOf(info.allAgg),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, Math.max(1, Math.min(top, 200)))

    return {
      time: Date.now(),
      scanning: store.scanning,
      scans: store.scans,
      failed: store.failed,
      rawSessions: store.rawSessions,
      harnessSessions: store.harnessSessions,
      foldedEvents: store.foldedEvents,
      dedupSkipped: store.dedupSkipped,
      lastError: store.lastError,
      scanError: store.scanError,
      lastScanAt: store.lastScanAt,
      sessions: store.sessions.size,
      range,
      totals: usageOf(store.allAgg),
      daily,
      hourly: hourlySeries(Math.max(1, Math.min(hours, 168))),
      byModel,
      bySession,
    }
  }

  // ---- JSON API route: GET /usage/api/dashboard ----
  // Registered as an EXACT route so it coexists with dsh-usage-widget's
  // `/usage/api` prefix route (the webserver matches the exact table first).
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/usage/api/dashboard',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // 信任围栏：仅回环 Host 可访问（防 DNS 重绑定 / 跨站探测）
        if (!isLoopbackHost(req.headers.host)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const q = url.searchParams
          const range = q.get('range') === '24h' || q.get('range') === '30d' || q.get('range') === 'all'
            ? q.get('range') as string
            : '7d'
          const hoursRaw = Number(q.get('hours'))
          const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.round(hoursRaw) : 24
          const topRaw = Number(q.get('top'))
          const top = Number.isFinite(topRaw) && topRaw > 0 ? Math.round(topRaw) : 8
          writeOk(res, dashboard(range, hours, top))
        } catch (error) {
          writeError(res, error)
        }
      },
    }), 'dsh-usage-dashboard: /usage/api/dashboard route')
  }
}
