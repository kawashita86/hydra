import { homedir } from 'os'
import { join } from 'path'
import { flushCodexCompactions, initialCodexFileState, parseCodexLine, type CodexFileState, type CodexParsedLimits } from '@shared/usage/codexLine'
import { parseClaudeUsageLine } from '@shared/usage/claudeLine'
import { PRICING_VERSION, estimateCost } from '@shared/usage/pricing'
import { summarize } from '@shared/usage/summary'
import { addTokens, type UsageScanProgress, type UsageBucket, type UsagePeriod, type UsageProvider, type UsageRecord, type UsageSummary } from '@shared/usage/types'
import { discoverClaudeProjectsDirs } from '../sessions/claudeProfiles'
import { nodeUsageFs, type UsageFileInfo, type UsageFs } from './usageFiles'

export interface UsageSource {
  provider: UsageProvider
  root: string
  maxDepth: number
}

export interface UsageStoreOptions {
  /** `<userData>/usage-cache`. */
  dir: string
  /** Re-evaluated on every scan. */
  sources: () => UsageSource[]
  fs?: UsageFs
  now?: () => number
  /** Lets the event loop run between chunks and files. Tests pass a no-op. */
  yieldToLoop?: () => Promise<void>
  /** Bytes read at a time (tests make it small). */
  chunkBytes?: number
}

export type { UsageScanProgress }

export interface UsageStoreStatus {
  indexing: boolean
  progress: UsageScanProgress | null
  lastScanAt: number | null
  files: number
}

export const CACHE_VERSION = 1
export const CHUNK_BYTES = 8 * 1024 * 1024
/** A cache larger than this is not one we wrote and is not read. */
export const MAX_CACHE_BYTES = 200 * 1024 * 1024
export const SAVE_INTERVAL_MS = 30 * 1000
export const SEEN_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000
export const BUCKET_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000
/** A Codex file untouched this long is not being written any more. */
export const QUIET_MS = 10 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const CACHE_FILE = 'v1.json'

/** The default places to read: every Claude profile, and Codex's sessions and archive. */
export function defaultUsageSources(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): UsageSource[] {
  const codexHome = env.CODEX_HOME || join(home, '.codex')
  return [
    ...discoverClaudeProjectsDirs(home, env).map((root) => ({ provider: 'claude' as const, root, maxDepth: 4 })),
    { provider: 'codex' as const, root: join(codexHome, 'sessions'), maxDepth: 5 },
    { provider: 'codex' as const, root: join(codexHome, 'archived_sessions'), maxDepth: 2 }
  ]
}

/** What is known about a file that is still on disk. */
interface FileEntry {
  provider: UsageProvider
  size: number
  mtimeMs: number
  ino: number
  /** Bytes consumed: the end of the last complete line read. */
  offset: number
  codexState?: CodexFileState
}

/** What a file added; kept after the file is gone. */
interface Contribution {
  provider: UsageProvider
  buckets: Map<string, UsageBucket>
  limits: CodexParsedLimits | null
}

interface SeenEntry {
  file: string
  ts: number
}

interface CacheShape {
  version: number
  pricingVersion: number
  lastScanAt: number | null
  files: Record<string, FileEntry>
  contributions: Array<{ path: string; provider: UsageProvider; buckets: UsageBucket[]; limits: CodexParsedLimits | null }>
  /** [key, index into `contributions`, ts] */
  seen: Array<[string, number, number]>
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export class UsageStore {
  private readonly dir: string
  private readonly sources: () => UsageSource[]
  private readonly fs: UsageFs
  private readonly now: () => number
  private readonly yieldToLoop: () => Promise<void>
  private readonly chunkBytes: number

  private files = new Map<string, FileEntry>()
  private contributions = new Map<string, Contribution>()
  private seen = new Map<string, SeenEntry>()
  private merged: UsageBucket[] | null = null
  private lastScanAt: number | null = null
  private dirty = false
  private lastSaveAt = 0

  private running: Promise<boolean> | null = null
  private listeners: Array<(p: UsageScanProgress) => void> = []
  private progress: UsageScanProgress | null = null

  constructor(options: UsageStoreOptions) {
    this.dir = options.dir
    this.sources = options.sources
    this.fs = options.fs ?? nodeUsageFs
    this.now = options.now ?? Date.now
    this.yieldToLoop = options.yieldToLoop ?? defaultYield
    this.chunkBytes = Math.max(1, options.chunkBytes ?? CHUNK_BYTES)
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /** Restores the cache. A missing, old or unreadable cache starts empty (one full rescan). */
  load(): void {
    this.files.clear()
    this.contributions.clear()
    this.seen.clear()
    this.merged = null
    this.lastScanAt = null
    try {
      const text = this.fs.readText(join(this.dir, CACHE_FILE), MAX_CACHE_BYTES)
      if (text === null) return
      const data = JSON.parse(text) as CacheShape
      if (data.version !== CACHE_VERSION || data.pricingVersion !== PRICING_VERSION) return
      const files = new Map<string, FileEntry>()
      for (const [path, e] of Object.entries(data.files)) {
        if (!isProvider(e.provider) || !isNum(e.size) || !isNum(e.mtimeMs) || !isNum(e.ino) || !isNum(e.offset)) return
        files.set(path, e)
      }
      const contributions = new Map<string, Contribution>()
      const order: string[] = []
      for (const c of data.contributions) {
        if (!isProvider(c.provider) || !Array.isArray(c.buckets)) return
        const buckets = new Map<string, UsageBucket>()
        for (const b of c.buckets) buckets.set(bucketKey(b.hour, b.model, b.projectKey), b)
        contributions.set(c.path, { provider: c.provider, buckets, limits: c.limits ?? null })
        order.push(c.path)
      }
      const seen = new Map<string, SeenEntry>()
      for (const [key, idx, ts] of data.seen) {
        const file = order[idx]
        if (file === undefined) return
        seen.set(key, { file, ts })
      }
      this.files = files
      this.contributions = contributions
      this.seen = seen
      this.lastScanAt = isNum(data.lastScanAt) ? data.lastScanAt : null
    } catch {
      this.files.clear()
      this.contributions.clear()
      this.seen.clear()
      this.lastScanAt = null
    }
  }

  /** Writes the cache now if anything changed since the last write. */
  flush(): void {
    if (!this.dirty) return
    try {
      const paths = [...this.contributions.keys()]
      const index = new Map(paths.map((p, i) => [p, i]))
      const cache: CacheShape = {
        version: CACHE_VERSION,
        pricingVersion: PRICING_VERSION,
        lastScanAt: this.lastScanAt,
        files: Object.fromEntries(this.files),
        contributions: paths.map((path) => {
          const c = this.contributions.get(path)!
          return { path, provider: c.provider, buckets: [...c.buckets.values()], limits: c.limits }
        }),
        seen: [...this.seen].flatMap(([key, e]): Array<[string, number, number]> => {
          const i = index.get(e.file)
          return i === undefined ? [] : [[key, i, e.ts]]
        })
      }
      this.fs.makeFolder(this.dir)
      this.fs.writeAtomic(join(this.dir, CACHE_FILE), JSON.stringify(cache))
      this.dirty = false
      this.lastSaveAt = this.now()
    } catch {
      /* stays dirty; tried again at the next save */
    }
  }

  stop(): void {
    this.flush()
  }

  // ── Reading results ────────────────────────────────────────────────────────

  buckets(): UsageBucket[] {
    if (!this.merged) {
      const sum = new Map<string, UsageBucket>()
      for (const c of this.contributions.values()) {
        for (const b of c.buckets.values()) {
          const key = `${b.provider}|${bucketKey(b.hour, b.model, b.projectKey)}`
          const into = sum.get(key)
          if (!into) {
            sum.set(key, { ...b, tokens: { ...b.tokens } })
          } else {
            into.tokens = addTokens(into.tokens, b.tokens)
            into.messages += b.messages
            into.costUsd += b.costUsd
            into.unpricedMessages += b.unpricedMessages
          }
        }
      }
      this.merged = [...sum.values()].sort(
        (a, b) => a.hour - b.hour || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.projectKey.localeCompare(b.projectKey)
      )
    }
    return this.merged
  }

  summary(period: UsagePeriod, now: Date, opts?: { projectKey?: string }): UsageSummary {
    return summarize(this.buckets(), period, now, opts)
  }

  /** The newest Codex rate limits seen in any file. */
  codexLimits(): CodexParsedLimits | null {
    let best: CodexParsedLimits | null = null
    for (const c of this.contributions.values()) {
      if (c.limits && (!best || c.limits.at > best.at)) best = c.limits
    }
    return best
  }

  status(): UsageStoreStatus {
    return { indexing: this.running !== null, progress: this.progress, lastScanAt: this.lastScanAt, files: this.files.size }
  }

  // ── Scanning ───────────────────────────────────────────────────────────────

  /** One incremental pass. Resolves `true` when the totals or limits changed. Calls made during a pass join it. */
  scan(onProgress?: (p: UsageScanProgress) => void): Promise<boolean> {
    if (onProgress) this.listeners.push(onProgress)
    if (!this.running) {
      this.running = this.runScan().finally(() => {
        this.running = null
        this.progress = null
        this.listeners = []
      })
    }
    return this.running
  }

  private report(): void {
    if (!this.progress) return
    for (const l of this.listeners) {
      try { l({ ...this.progress }) } catch { /* a listener must not stop the scan */ }
    }
  }

  private async runScan(): Promise<boolean> {
    const startedAt = this.now()
    const found = new Map<string, { provider: UsageProvider; info: UsageFileInfo }>()
    for (const source of this.sources()) {
      let list: UsageFileInfo[] = []
      try { list = this.fs.walk(source.root, source.maxDepth) } catch { /* unreadable root */ }
      for (const info of list) if (!found.has(info.path)) found.set(info.path, { provider: source.provider, info })
    }

    let changed = false
    const work: Array<{ path: string; provider: UsageProvider; info: UsageFileInfo; fresh: boolean; flushOnly: boolean }> = []
    for (const [path, { provider, info }] of found) {
      const entry = this.files.get(path)
      const fresh = !entry || entry.provider !== provider || entry.ino !== info.ino || info.size < entry.offset || info.size < entry.size
      const same = !fresh && entry!.size === info.size && entry!.mtimeMs === info.mtimeMs
      if (same) {
        if (provider === 'codex' && entry!.codexState?.pendingCompactions.length && startedAt - info.mtimeMs > QUIET_MS) {
          work.push({ path, provider, info, fresh: false, flushOnly: true })
        }
        continue
      }
      work.push({ path, provider, info, fresh, flushOnly: false })
    }

    // Files that are gone keep what they added; only the read position is forgotten.
    for (const path of [...this.files.keys()]) {
      if (!found.has(path)) {
        this.files.delete(path)
        this.dirty = true
      }
    }

    const progress: UsageScanProgress = {
      filesDone: 0,
      filesTotal: work.length,
      bytesDone: 0,
      bytesTotal: work.reduce((n, w) => n + (w.fresh ? w.info.size : Math.max(0, w.info.size - (this.files.get(w.path)?.offset ?? 0))), 0)
    }
    this.progress = progress
    this.report()

    for (const w of work) {
      if (await this.processFile(w, startedAt, progress)) changed = true
      progress.filesDone += 1
      this.report()
      await this.yieldToLoop()
    }

    if (this.prune(startedAt)) changed = true
    if (changed) this.merged = null
    this.lastScanAt = startedAt
    if (changed || work.length > 0) {
      this.dirty = true
      if (startedAt - this.lastSaveAt >= SAVE_INTERVAL_MS) this.flush()
    }
    return changed
  }

  /** Reads what a file gained. Returns true when its contribution changed. */
  private async processFile(
    w: { path: string; provider: UsageProvider; info: UsageFileInfo; fresh: boolean; flushOnly: boolean },
    now: number,
    progress: UsageScanProgress
  ): Promise<boolean> {
    const { path, provider, info } = w
    let changed = false
    if (w.fresh) {
      changed = this.forget(path)
      this.files.set(path, { provider, size: 0, mtimeMs: 0, ino: info.ino, offset: 0 })
    }
    const entry = this.files.get(path)!
    if (provider === 'codex' && !entry.codexState) entry.codexState = initialCodexFileState()
    const contribution = this.contributionOf(path, provider)

    if (!w.flushOnly) {
      let ok = true
      for (;;) {
        let chunk: Buffer
        try {
          chunk = this.fs.readChunk(path, entry.offset, this.chunkBytes)
        } catch {
          ok = false // gone or not an ordinary file any more: tried again at the next scan
          break
        }
        if (chunk.length === 0) break
        const last = chunk.lastIndexOf(0x0a)
        let consumed: number
        if (last >= 0) consumed = last + 1
        else if (chunk.length >= this.chunkBytes) consumed = chunk.length // a line longer than a chunk is no record
        else break // partial last line waits
        if (last >= 0) {
          let start = 0
          while (start < consumed) {
            const end = chunk.indexOf(0x0a, start)
            if (end > start) {
              if (this.consumeLine(path, provider, entry, contribution, chunk.toString('utf8', start, end))) changed = true
            }
            start = end + 1
          }
        }
        entry.offset += consumed
        progress.bytesDone += consumed
        this.dirty = true
        if (chunk.length < this.chunkBytes) break
        this.report()
        await this.yieldToLoop()
      }
      if (ok) {
        entry.size = info.size
        entry.mtimeMs = info.mtimeMs
        entry.ino = info.ino
      }
    }

    if (provider === 'codex' && entry.codexState && now - info.mtimeMs > QUIET_MS) {
      for (const u of flushCodexCompactions(entry.codexState)) {
        if (this.addRecord(path, provider, contribution, u.record, u.dedupeKey)) changed = true
        this.dirty = true
      }
    }
    return changed
  }

  private consumeLine(
    path: string,
    provider: UsageProvider,
    entry: FileEntry,
    contribution: Contribution,
    line: string
  ): boolean {
    let changed = false
    if (provider === 'claude') {
      const parsed = parseClaudeUsageLine(line)
      if (parsed) changed = this.addRecord(path, provider, contribution, parsed.record, parsed.dedupeKey)
    } else {
      const parsed = parseCodexLine(line, entry.codexState!)
      if (!parsed) return false
      for (const u of parsed.usage ?? []) {
        if (this.addRecord(path, provider, contribution, u.record, u.dedupeKey)) changed = true
      }
      if (parsed.limits && (!contribution.limits || parsed.limits.at >= contribution.limits.at)) {
        contribution.limits = parsed.limits
        changed = true
      }
    }
    return changed
  }

  private contributionOf(path: string, provider: UsageProvider): Contribution {
    let c = this.contributions.get(path)
    if (!c) {
      c = { provider, buckets: new Map(), limits: null }
      this.contributions.set(path, c)
    }
    return c
  }

  /**
   * Counts a record once. A key already owned (by this or another file) is
   * skipped; a record without a key is always counted (Codex lines without a
   * stable key are unique by position, so they never collide anyway).
   */
  private addRecord(
    path: string,
    provider: UsageProvider,
    contribution: Contribution,
    record: UsageRecord,
    dedupeKey: string | null
  ): boolean {
    if (dedupeKey !== null) {
      const key = `${provider}:${dedupeKey}`
      if (this.seen.has(key)) return false
      this.seen.set(key, { file: path, ts: record.ts })
    }
    const hour = Math.floor(record.ts / HOUR_MS) * HOUR_MS
    const key = bucketKey(hour, record.model, record.projectKey)
    let bucket = contribution.buckets.get(key)
    if (!bucket) {
      bucket = {
        hour,
        provider,
        model: record.model,
        projectKey: record.projectKey,
        tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
        messages: 0,
        costUsd: 0,
        unpricedMessages: 0
      }
      contribution.buckets.set(key, bucket)
    }
    bucket.tokens = addTokens(bucket.tokens, record.tokens)
    bucket.messages += 1
    const cost = estimateCost(record.model, record.tokens)
    if (cost === null) bucket.unpricedMessages += 1
    else bucket.costUsd += cost
    return true
  }

  /** Drops what a file added and the keys it owned. True when there was anything. */
  private forget(path: string): boolean {
    const had = this.contributions.delete(path)
    for (const [key, e] of this.seen) if (e.file === path) this.seen.delete(key)
    return had
  }

  private prune(now: number): boolean {
    let changed = false
    for (const [key, e] of this.seen) {
      if (e.ts < now - SEEN_MAX_AGE_MS) {
        this.seen.delete(key)
        this.dirty = true
      }
    }
    const cutoff = now - BUCKET_MAX_AGE_MS
    for (const [path, c] of this.contributions) {
      for (const [key, b] of c.buckets) {
        if (b.hour < cutoff) {
          c.buckets.delete(key)
          changed = true
        }
      }
      if (c.buckets.size === 0 && !c.limits && !this.files.has(path)) this.contributions.delete(path)
    }
    if (changed) this.dirty = true
    return changed
  }
}

function bucketKey(hour: number, model: string, projectKey: string): string {
  return `${hour}|${model}|${projectKey}`
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isProvider(v: unknown): v is UsageProvider {
  return v === 'claude' || v === 'codex'
}
