import { EventEmitter } from 'events'
import type { CodexParsedLimits } from '@shared/usage/codexLine'
import { buildUsageReport, type UsageReport, type UsageReportProvider } from '@shared/usage/report'
import type {
  ClaudeProfileLimits,
  UsagePeriod,
  UsageScanProgress,
  UsageBucket,
  UsageState,
  UsageSummary
} from '@shared/usage/types'

/** The slice of `UsageStore` the service uses. */
export interface UsageStoreLike {
  load(): void
  scan(onProgress?: (p: UsageScanProgress) => void): Promise<boolean>
  summary(period: UsagePeriod, now: Date, opts?: { projectKey?: string }): UsageSummary
  buckets(): UsageBucket[]
  codexLimits(): CodexParsedLimits | null
  status(): { indexing: boolean; progress: UsageScanProgress | null; lastScanAt: number | null }
  stop(): void
}

/** The slice of `ClaudeLimitsClient` the service uses. */
export interface ClaudeLimitsLike {
  refresh(): Promise<ClaudeProfileLimits[]>
  current(): ClaudeProfileLimits[]
}

export interface UsageServiceOptions {
  store: UsageStoreLike
  limits: ClaudeLimitsLike
  now?: () => number
}

export const SCAN_INTERVAL_MS = 60_000
export const LIMITS_INTERVAL_MS = 5 * 60_000
export const LIMITS_VISIBLE_INTERVAL_MS = 60_000
/** A ping keeps the faster cadence on for this long (the renderer pings every 30 s). */
export const VISIBLE_TTL_MS = 45_000
export const IDLE_THROTTLE_MS = 60_000
export const PROGRESS_EMIT_MS = 500
/** How often the limits cadence is evaluated (so visibility expiry is noticed). */
const LIMITS_TICK_MS = 10_000

/**
 * Daemon-side owner of the usage store and the Claude limits client: schedules scans and polls,
 * and emits `'changed'` (UsageState) when something the renderer shows changed.
 */
export class UsageService extends EventEmitter {
  private readonly store: UsageStoreLike
  private readonly limits: ClaudeLimitsLike
  private readonly now: () => number

  private scanTimer: ReturnType<typeof setInterval> | null = null
  private limitsTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private lastVisibleAt = -Infinity
  private lastLimitsAt = -Infinity
  private lastIdleAt = -Infinity
  private lastProgressEmitAt = -Infinity
  private dataVersion = 0
  private lastKey = ''
  private refreshing: Promise<UsageState> | null = null

  constructor(opts: UsageServiceOptions) {
    super()
    this.store = opts.store
    this.limits = opts.limits
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      this.store.load()
    } catch {
      /* starts empty */
    }
    // Never block startup: the first scan of a big history runs in the background.
    void this.scanNow()
    void this.refreshLimits()
    this.scanTimer = setInterval(() => void this.scanNow(), SCAN_INTERVAL_MS)
    this.limitsTimer = setInterval(() => {
      const every = this.isVisible() ? LIMITS_VISIBLE_INTERVAL_MS : LIMITS_INTERVAL_MS
      if (this.now() - this.lastLimitsAt >= every) void this.refreshLimits()
    }, LIMITS_TICK_MS)
    this.scanTimer.unref?.()
    this.limitsTimer.unref?.()
  }

  stop(): void {
    this.started = false
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.limitsTimer) clearInterval(this.limitsTimer)
    this.scanTimer = null
    this.limitsTimer = null
    this.store.stop()
  }

  /** A usage surface (popover, Overview card) is on screen. */
  setVisible(): void {
    const was = this.isVisible()
    this.lastVisibleAt = this.now()
    if (!was && this.now() - this.lastLimitsAt >= LIMITS_VISIBLE_INTERVAL_MS) void this.refreshLimits()
  }

  /** A Claude agent went from working to idle: its transcript and the limits just moved. */
  notifyAgentIdle(): void {
    const now = this.now()
    if (now - this.lastIdleAt < IDLE_THROTTLE_MS) return
    this.lastIdleAt = now
    void this.scanNow()
    void this.refreshLimits()
  }

  /** Scan and poll now; calls made meanwhile share the run. */
  refresh(): Promise<UsageState> {
    if (!this.refreshing) {
      this.refreshing = Promise.all([this.scanNow(), this.refreshLimits()])
        .then(() => this.state())
        .finally(() => {
          this.refreshing = null
        })
    }
    return this.refreshing
  }

  state(): UsageState {
    const status = this.store.status()
    // Only the first full index is shown; the sub-second incremental passes would just flicker.
    const indexing = status.indexing && status.lastScanAt === null
    return {
      claude: this.limits.current(),
      codex: this.store.codexLimits(),
      indexing: { indexing, progress: indexing ? status.progress : null, lastScanAt: status.lastScanAt },
      dataVersion: this.dataVersion,
      updatedAt: this.now()
    }
  }

  summary(period: UsagePeriod, projectKey?: string): UsageSummary {
    return this.store.summary(period, new Date(), projectKey ? { projectKey } : undefined)
  }

  report(days: number, provider: UsageReportProvider): UsageReport {
    return buildUsageReport(this.store.buckets(), { days, provider, now: new Date(this.now()) })
  }

  private isVisible(): boolean {
    return this.now() - this.lastVisibleAt <= VISIBLE_TTL_MS
  }

  private async scanNow(): Promise<void> {
    try {
      const changed = await this.store.scan(() => this.emitIfChanged())
      if (changed) this.dataVersion++
    } catch {
      /* the next pass tries again */
    }
    this.emitIfChanged()
  }

  private async refreshLimits(): Promise<void> {
    this.lastLimitsAt = this.now()
    try {
      await this.limits.refresh()
    } catch {
      /* the client keeps its last good values */
    }
    this.emitIfChanged()
  }

  private emitIfChanged(): void {
    const state = this.state()
    if (state.indexing.indexing) {
      // Progress states (from any trigger) are at most one per PROGRESS_EMIT_MS.
      const now = this.now()
      if (now - this.lastProgressEmitAt < PROGRESS_EMIT_MS) return
      this.lastProgressEmitAt = now
    }
    const { updatedAt: _updatedAt, ...rest } = state
    const key = JSON.stringify(rest)
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('changed', state)
  }
}
