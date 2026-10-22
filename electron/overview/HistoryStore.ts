// Adapted from agent-lookout (MIT, © 2026 Idris Olubisi): src/collector/history/historyKeeper.ts, historyFormat.ts, historyLimits.ts, src/collector/eventStore.ts, historyStore.ts
import { join } from 'path'
import type {
  HistoryAgent,
  HistoryPoint,
  HistoryResponse,
  OverviewEvent,
  OverviewStatus
} from '@shared/overview/types'
import { nodeHistoryFs, type HistoryFs } from './historyFiles'

/** Events kept in memory. */
export const MAX_EVENTS = 1000
/** Points kept in memory: 6 h of one point every 5 s. */
export const MAX_POINTS = 4320
/** Interval between two history points (kept by the tracker). */
export const SAMPLE_INTERVAL_MS = 5000
/** The most one file may hold; a day that outgrows it goes on in `-2`, `-3`... */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** The most all history files may hold. */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024
/** A day is kept this long after it ends. */
export const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000
/** A file larger than this is not one we wrote and is not read. */
const MAX_READ_BYTES = 2 * MAX_FILE_BYTES
/** A longer line is not a record. */
const MAX_LINE_LENGTH = 8 * 1024
const MAX_TEXT_LENGTH = 1024
/** Records dated this far after the clock were written while the clock was wrong. */
const FUTURE_SLACK_MS = 60 * 1000
/** Unwritten lines kept when writing keeps failing. */
const MAX_PENDING_LINES = 20000
const DAY_MS = 24 * 60 * 60 * 1000
/** A finished or failed agent stays in the points written to disk this long. */
const ENDED_KEPT_MS = 60 * 60 * 1000

const STATUSES: ReadonlySet<string> = new Set<OverviewStatus>([
  'needs-you', 'working', 'idle', 'starting', 'finished', 'failed'
])
const EVENT_KINDS: ReadonlySet<string> = new Set(['appeared', 'status', 'ended', 'resumed'])
const REASONS: ReadonlySet<string> = new Set(['permission', 'question', 'other'])

// ── File names ───────────────────────────────────────────────────────────────

interface FileName {
  name: string
  day: string
  dayStart: number
  part: number
}

const FILE_NAME = /^v1-(\d{4})-(\d{2})-(\d{2})(?:-([2-9]|[1-9]\d{1,3}))?\.jsonl$/

/** The UTC day of a moment, `2026-10-06`. */
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** `v1-2026-10-06.jsonl`, then `v1-2026-10-06-2.jsonl`. */
export function historyFileName(day: string, part = 1): string {
  return `v1-${day}${part > 1 ? `-${part}` : ''}.jsonl`
}

/** A name read as a v1 history file's, `null` for anything else (other formats are left alone). */
export function parseHistoryFileName(name: string): FileName | null {
  const m = FILE_NAME.exec(name)
  if (!m) return null
  const day = `${m[1]}-${m[2]}-${m[3]}`
  const dayStart = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(dayStart) || dayOf(dayStart) !== day) return null
  return { name, day, dayStart, part: m[4] ? Number(m[4]) : 1 }
}

function byFileOrder(a: FileName, b: FileName): number {
  return a.dayStart - b.dayStart || a.part - b.part
}

/**
 * The files to delete, oldest first: every file whose day ended more than
 * `maxAgeMs` ago, then the oldest until the rest and `incoming` fit in
 * `maxBytes`. Files in `writing` never go.
 */
export function filesToDelete(
  files: (FileName & { size: number })[],
  writing: ReadonlySet<string>,
  incoming: number,
  limits: { now: number; maxBytes: number; maxAgeMs: number }
): string[] {
  const ordered = [...files].sort(byFileOrder)
  const doomed: string[] = []
  const left: typeof ordered = []
  let total = 0
  for (const file of ordered) {
    if (!writing.has(file.name) && file.dayStart + DAY_MS + limits.maxAgeMs < limits.now) {
      doomed.push(file.name)
    } else {
      left.push(file)
      total += file.size
    }
  }
  for (const file of left) {
    if (total + incoming <= limits.maxBytes) break
    if (writing.has(file.name)) continue
    doomed.push(file.name)
    total -= file.size
  }
  return doomed
}

// ── Records ──────────────────────────────────────────────────────────────────

type HistoryRecord =
  | { kind: 'start'; at: number }
  /** `delta` is set on a point read from a delta line: ids that changed, `null` for an agent that is gone. */
  | { kind: 'point'; point: HistoryPoint; delta?: Record<string, OverviewStatus | null> }
  | { kind: 'event'; event: OverviewEvent }

function recordAt(r: HistoryRecord): number {
  return r.kind === 'point' ? r.point.at : r.kind === 'event' ? r.event.at : r.at
}

/**
 * A point as one line. With no `base` the line holds the full status map
 * (the first point of a run and of each file, so any file restores on its
 * own). With a `base` (the map of the previous point written to the same
 * file) it holds a delta, marked by a trailing `1`: the agents whose status
 * changed, and `null` for those that are gone.
 */
function encodePoint(p: HistoryPoint, statuses: Record<string, OverviewStatus>, base: Record<string, OverviewStatus> | null): string {
  const head = [p.at, p.needsYou, p.working, p.idle, p.total]
  if (!base) return `${JSON.stringify({ point: [...head, statuses] })}\n`
  const delta: Record<string, OverviewStatus | null> = {}
  for (const [id, st] of Object.entries(statuses)) if (base[id] !== st) delta[id] = st
  for (const id of Object.keys(base)) if (!(id in statuses)) delta[id] = null
  return `${JSON.stringify({ point: [...head, delta, 1] })}\n`
}

/** A non-point record as one line. Events are written field by field, so nothing else can reach a file. */
function encodeRecord(r: Exclude<HistoryRecord, { kind: 'point' }>): string {
  if (r.kind === 'start') return `${JSON.stringify({ start: r.at })}\n`
  const e = r.event
  const out: Record<string, unknown> = {
    id: e.id,
    at: e.at,
    kind: e.kind,
    agentId: e.agentId,
    name: e.name,
    projectDir: e.projectDir
  }
  if (e.from !== undefined) out.from = e.from
  if (e.to !== undefined) out.to = e.to
  if (e.waitingReason !== undefined) out.waitingReason = e.waitingReason
  if (e.waitedMs !== undefined) out.waitedMs = e.waitedMs
  if (e.gapMs !== undefined) out.gapMs = e.gapMs
  return `${JSON.stringify({ event: out })}\n`
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_TEXT_LENGTH ? v : null
}

function status(v: unknown): OverviewStatus | undefined {
  return typeof v === 'string' && STATUSES.has(v) ? (v as OverviewStatus) : undefined
}

function decodeEvent(v: unknown): OverviewEvent | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const id = text(o.id)
  const at = num(o.at)
  const agentId = text(o.agentId)
  const name = text(o.name)
  const projectDir = text(o.projectDir)
  if (id === null || at === null || agentId === null || name === null || projectDir === null) return null
  if (typeof o.kind !== 'string' || !EVENT_KINDS.has(o.kind)) return null
  const event: OverviewEvent = { id, at, kind: o.kind as OverviewEvent['kind'], agentId, name, projectDir }
  const from = status(o.from)
  const to = status(o.to)
  const waited = num(o.waitedMs)
  const gap = num(o.gapMs)
  if (from) event.from = from
  if (to) event.to = to
  if (typeof o.waitingReason === 'string' && REASONS.has(o.waitingReason)) {
    event.waitingReason = o.waitingReason as OverviewEvent['waitingReason']
  }
  if (waited !== null) event.waitedMs = waited
  if (gap !== null) event.gapMs = gap
  return event
}

function decodePoint(v: unknown): Extract<HistoryRecord, { kind: 'point' }> | null {
  if (!Array.isArray(v) || v.length < 5) return null
  const [at, needsYou, working, idle, total] = v.slice(0, 5).map(num)
  if (at === null || needsYou === null || working === null || idle === null || total === null) return null
  const isDelta = v[6] === 1
  const statuses: Record<string, OverviewStatus> = {}
  const delta: Record<string, OverviewStatus | null> = {}
  const raw = v[5]
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [id, s] of Object.entries(raw)) {
      if (id.length > MAX_TEXT_LENGTH) continue
      const st = status(s)
      if (st) {
        statuses[id] = st
        delta[id] = st
      } else if (s === null && isDelta) delta[id] = null
    }
  }
  const point = { at, needsYou, working, idle, total, statuses }
  return isDelta ? { kind: 'point', point, delta } : { kind: 'point', point }
}

/** One line as a record, `null` when it is not one (blank, too long, malformed, unknown). */
function decodeLine(line: string): HistoryRecord | null {
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if ('start' in o) {
    const at = num(o.start)
    return at === null ? null : { kind: 'start', at }
  }
  if ('point' in o) {
    return decodePoint(o.point)
  }
  if ('event' in o) {
    const event = decodeEvent(o.event)
    return event ? { kind: 'event', event } : null
  }
  return null
}

// ── The store ────────────────────────────────────────────────────────────────

export interface HistoryStoreOptions {
  /** Folder of the history files, `<userData>/overview-history`. */
  dir: string
  fs?: HistoryFs
  now?: () => number
  /** Clock for the restore time budget. Default `Date.now`. */
  budgetClock?: () => number
  /** Default 5 s. */
  flushIntervalMs?: number
  /** Most time `start()` may spend reading files. Default 10 s. */
  restoreBudgetMs?: number
}

/**
 * Events and samples of the Overview, in memory rings and as JSON lines on disk.
 *
 * Single writer: the daemon is single-instance (`daemon/lock.ts`), so no
 * writer lock is needed. Do not open the same folder from a second process.
 *
 * Nothing is written while a poll runs: records are buffered and appended
 * every `flushIntervalMs` and on `stop()`. When the folder cannot be made or
 * written, the store keeps working in memory.
 */
export class HistoryStore {
  private readonly dir: string
  private readonly fs: HistoryFs
  private readonly now: () => number
  private readonly budgetClock: () => number
  private readonly flushIntervalMs: number
  private readonly restoreBudgetMs: number

  private events: OverviewEvent[] = []
  private points: HistoryPoint[] = []
  private starts: number[] = []
  private readonly names = new Map<string, HistoryAgent>()
  private startedAt = 0
  /** Where the restored history begins; `null` when nothing was restored. */
  private sinceAt: number | null = null
  private trimmed = false

  private pending: { day: string; record: HistoryRecord; disk?: Record<string, OverviewStatus> }[] = []
  /** When each finished or failed agent was first seen so, to leave it out of points after an hour. */
  private readonly endedSince = new Map<string, number>()
  /** The status map of the last point written, and the file it went to. */
  private base: Record<string, OverviewStatus> | null = null
  private baseFile: string | null = null
  /** Files this run has appended to; the first append to a non-empty one starts with a line break. */
  private readonly touched = new Set<string>()
  private persist = true
  private warned = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: HistoryStoreOptions) {
    this.dir = options.dir
    this.fs = options.fs ?? nodeHistoryFs
    this.now = options.now ?? Date.now
    this.budgetClock = options.budgetClock ?? Date.now
    this.flushIntervalMs = options.flushIntervalMs ?? SAMPLE_INTERVAL_MS
    this.restoreBudgetMs = options.restoreBudgetMs ?? 10_000
  }

  /** Restores what the folder holds, records a `start`, and begins flushing. */
  start(): void {
    if (this.timer) return
    this.startedAt = this.now()
    try {
      this.fs.makeFolder(this.dir)
    } catch (err) {
      this.persist = false
      this.warn('cannot make the history folder, keeping history in memory', err)
    }
    if (this.persist) this.restore()
    this.starts.push(this.startedAt)
    this.enqueue({ kind: 'start', at: this.startedAt })
    this.flush()
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs)
    this.timer.unref?.()
  }

  /** Stops the timer and writes what is left. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flush()
  }

  addEvents(events: OverviewEvent[]): void {
    for (const event of events) {
      this.events.push(event)
      if (event.agentId) this.names.set(event.agentId, { name: event.name, projectDir: event.projectDir })
      this.enqueue({ kind: 'event', event })
    }
    this.trimEvents()
  }

  /** `agents` tells the names of the agents in `point.statuses`. */
  addPoint(point: HistoryPoint, agents?: Record<string, HistoryAgent>): void {
    this.points.push(point)
    if (agents) for (const [id, a] of Object.entries(agents)) this.names.set(id, a)
    this.enqueue({ kind: 'point', point })
    if (this.points.length > MAX_POINTS) {
      this.points.splice(0, this.points.length - MAX_POINTS)
      this.trimmed = true
    }
  }

  /** When the newest point was taken, restored ones included; `null` when there is none. */
  lastPointAt(): number | null {
    return this.points.length > 0 ? this.points[this.points.length - 1].at : null
  }

  /** Points, events and starts from `sinceMs` on, oldest first, and the names of the agents they mention. */
  query(sinceMs: number): HistoryResponse {
    const points = this.points.filter((p) => p.at >= sinceMs)
    const events = this.events.filter((e) => e.at >= sinceMs)
    const agents: Record<string, HistoryAgent> = {}
    const note = (id: string): void => {
      const a = this.names.get(id)
      if (a) agents[id] = a
    }
    for (const p of points) for (const id of Object.keys(p.statuses)) note(id)
    for (const e of events) if (e.agentId) note(e.agentId)
    const begins = this.sinceAt ?? this.startedAt
    const since = this.trimmed && this.points.length > 0 ? Math.max(begins, this.points[0].at) : begins
    return {
      since,
      startedAt: this.startedAt,
      starts: this.starts.filter((s) => s >= sinceMs),
      points,
      events,
      agents
    }
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  private trimEvents(): void {
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  private enqueue(record: HistoryRecord): void {
    if (!this.persist) return
    let disk: Record<string, OverviewStatus> | undefined
    if (record.kind === 'point') disk = this.diskStatuses(record.point)
    this.pending.push({ day: dayOf(recordAt(record)), record, disk })
    if (this.pending.length > MAX_PENDING_LINES) this.pending.splice(0, this.pending.length - MAX_PENDING_LINES)
  }

  /** The statuses a point keeps on disk: agents finished or failed for over an hour are left out. */
  private diskStatuses(point: HistoryPoint): Record<string, OverviewStatus> {
    const out: Record<string, OverviewStatus> = {}
    for (const [id, st] of Object.entries(point.statuses)) {
      if (st === 'finished' || st === 'failed') {
        const since = this.endedSince.get(id) ?? point.at
        this.endedSince.set(id, since)
        if (point.at - since > ENDED_KEPT_MS) continue
      } else {
        this.endedSince.delete(id)
      }
      out[id] = st
    }
    for (const id of [...this.endedSince.keys()]) if (!(id in point.statuses)) this.endedSince.delete(id)
    return out
  }

  // ── Disk ───────────────────────────────────────────────────────────────────

  private warn(message: string, err: unknown): void {
    if (this.warned) return
    this.warned = true
    console.warn(`[overview-history] ${message}:`, err)
  }

  private scan(): (FileName & { size: number; ordinary: boolean })[] {
    const files: (FileName & { size: number; ordinary: boolean })[] = []
    for (const name of this.fs.list(this.dir)) {
      const parsed = parseHistoryFileName(name)
      if (!parsed) continue
      const info = this.fs.stat(join(this.dir, name))
      if (info) files.push({ ...parsed, size: info.size, ordinary: info.kind === 'file' })
    }
    return files
  }

  private restore(): void {
    const now = this.now()
    const deadline = this.budgetClock() + this.restoreBudgetMs
    let files: ReturnType<HistoryStore['scan']>
    try {
      files = this.scan().sort(byFileOrder).reverse() // newest first
    } catch (err) {
      this.warn('cannot read the history folder', err)
      return
    }

    const eventChunks: OverviewEvent[][] = []
    const pointChunks: HistoryPoint[][] = []
    const startChunks: number[][] = []
    let eventCount = 0
    let pointCount = 0
    let oldest: number | null = null
    for (const file of files) {
      if (this.budgetClock() > deadline) break
      if (!file.ordinary || file.size > MAX_READ_BYTES) continue
      let content: string
      try {
        content = this.fs.read(join(this.dir, file.name), MAX_READ_BYTES)
      } catch {
        continue
      }
      const events: OverviewEvent[] = []
      const points: HistoryPoint[] = []
      const starts: number[] = []
      let first: number | null = null
      // Status map of the last point read from this file; a delta needs a full point before it.
      let state: Record<string, OverviewStatus> | null = null
      for (const line of content.split('\n')) {
        const record = decodeLine(line)
        if (!record) continue
        const at = recordAt(record)
        if (at > now + FUTURE_SLACK_MS) continue
        first = first === null ? at : Math.min(first, at)
        if (record.kind === 'event') events.push(record.event)
        else if (record.kind === 'point') {
          if (record.delta) {
            if (!state) continue
            const next: Record<string, OverviewStatus> = { ...state }
            for (const [id, st] of Object.entries(record.delta)) {
              if (st === null) delete next[id]
              else next[id] = st
            }
            state = next
          } else {
            state = { ...record.point.statuses }
          }
          points.push({ ...record.point, statuses: { ...state } })
        } else starts.push(record.at)
      }
      eventChunks.unshift(events)
      pointChunks.unshift(points)
      startChunks.unshift(starts)
      eventCount += events.length
      pointCount += points.length
      if (first !== null) oldest = first
      if (eventCount >= MAX_EVENTS && pointCount >= MAX_POINTS) break
    }

    // Files hold records in time order; sort anyway so a skewed clock cannot disorder the rings.
    const events = eventChunks.flat().sort((a, b) => a.at - b.at)
    const points = pointChunks.flat().sort((a, b) => a.at - b.at)
    this.events = events.slice(-MAX_EVENTS)
    this.points = points.slice(-MAX_POINTS)
    this.trimmed = points.length > MAX_POINTS
    this.starts = startChunks.flat().sort((a, b) => a - b)
    this.sinceAt = oldest
    for (const e of this.events) {
      if (e.agentId) this.names.set(e.agentId, { name: e.name, projectDir: e.projectDir })
    }
  }

  /** Appends what is buffered, pruning old files first. Failures keep the lines for the next try. */
  flush(): void {
    if (!this.persist || this.pending.length === 0) return
    const now = this.now()
    try {
      const files = this.scan()
      const byDay = new Map<string, typeof this.pending>()
      for (const item of this.pending) {
        const items = byDay.get(item.day)
        if (items) items.push(item)
        else byDay.set(item.day, [item])
      }

      // Pick the file each day's lines go to: the day's last, or the next one when it is full or not ordinary.
      const targets = new Map<
        string,
        { name: string; size: number; chunk: string; base: Record<string, OverviewStatus> | null; baseFile: string | null }
      >()
      let incoming = 0
      let base = this.base
      let baseFile = this.baseFile
      for (const [day, items] of byDay) {
        const sameDay = files.filter((f) => f.day === day).sort(byFileOrder)
        const last = sameDay[sameDay.length - 1]
        let part = last ? last.part : 1
        let size = last && last.ordinary ? last.size : 0
        // Upper bound of the chunk, with every point full, to decide whether the file has room.
        const bound = items.reduce(
          (n, { record, disk }) =>
            n + (record.kind === 'point' && disk ? encodePoint(record.point, disk, null) : encodeRecord(record as Exclude<HistoryRecord, { kind: 'point' }>)).length,
          0
        )
        if (last && (!last.ordinary || (size > 0 && size + bound > MAX_FILE_BYTES))) {
          part += 1
          size = 0
        }
        const name = historyFileName(day, part)
        // The first point written to a file is full, so each file restores on its own.
        const parts: string[] = []
        for (const { record, disk } of items) {
          if (record.kind === 'point' && disk) {
            parts.push(encodePoint(record.point, disk, baseFile === name ? base : null))
            base = disk
            baseFile = name
          } else {
            parts.push(encodeRecord(record as Exclude<HistoryRecord, { kind: 'point' }>))
          }
        }
        const chunk = parts.join('')
        targets.set(day, { name, size, chunk, base, baseFile })
        incoming += chunk.length
      }

      const writing = new Set([...targets.values()].map((t) => t.name))
      for (const name of filesToDelete(files, writing, incoming, {
        now,
        maxBytes: MAX_TOTAL_BYTES,
        maxAgeMs: MAX_AGE_MS
      })) {
        try {
          this.fs.remove(join(this.dir, name))
          this.touched.delete(name)
        } catch (err) {
          this.warn('cannot delete an old history file', err)
        }
      }

      const failed = new Set<string>()
      for (const [day, target] of targets) {
        const lead = target.size > 0 && !this.touched.has(target.name) ? '\n' : ''
        try {
          this.fs.append(join(this.dir, target.name), lead + target.chunk)
          this.touched.add(target.name)
          this.base = target.base
          this.baseFile = target.baseFile
        } catch (err) {
          failed.add(day)
          this.warn('cannot write the history', err)
        }
      }
      this.pending = this.pending.filter((p) => failed.has(p.day))
    } catch (err) {
      this.warn('cannot write the history', err)
    }
  }
}
