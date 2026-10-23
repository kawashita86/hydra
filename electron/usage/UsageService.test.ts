import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeProfileLimits, UsageScanProgress, UsageState } from '@shared/usage/types'
import { ClaudeLimitsClient } from './ClaudeLimitsClient'
import {
  IDLE_THROTTLE_MS,
  LIMITS_INTERVAL_MS,
  PROGRESS_EMIT_MS,
  SCAN_INTERVAL_MS,
  UsageService,
  VISIBLE_TTL_MS,
  type ClaudeLimitsLike,
  type UsageStoreLike
} from './UsageService'

class FakeStore implements UsageStoreLike {
  loaded = 0
  stopped = 0
  scans = 0
  lastScanAt: number | null = null
  indexing = false
  progress: UsageScanProgress | null = null
  changedNext = false
  progressSteps: UsageScanProgress[] = []
  gate: Promise<void> | null = null
  load(): void {
    this.loaded++
  }
  async scan(onProgress?: (p: UsageScanProgress) => void): Promise<boolean> {
    this.scans++
    this.indexing = true
    for (const p of this.progressSteps) {
      this.progress = p
      onProgress?.(p)
    }
    if (this.gate) await this.gate
    this.indexing = false
    this.lastScanAt = Date.now()
    const changed = this.changedNext
    this.changedNext = false
    return changed
  }
  summary = vi.fn(() => ({}) as never)
  codexLimits = (): null => null
  status() {
    return { indexing: this.indexing, progress: this.progress, lastScanAt: this.lastScanAt }
  }
  stop(): void {
    this.stopped++
  }
}

class FakeLimits implements ClaudeLimitsLike {
  calls = 0
  data: ClaudeProfileLimits[] = []
  async refresh(): Promise<ClaudeProfileLimits[]> {
    this.calls++
    return this.data
  }
  current(): ClaudeProfileLimits[] {
    return this.data
  }
}

function make() {
  const store = new FakeStore()
  const limits = new FakeLimits()
  const service = new UsageService({ store, limits })
  const changed: UsageState[] = []
  service.on('changed', (s: UsageState) => changed.push(s))
  return { store, limits, service, changed }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T10:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('UsageService', () => {
  it('loads, then scans in the background without blocking start()', async () => {
    const { store, limits, service } = make()
    store.gate = new Promise(() => {}) // never finishes
    service.start()
    expect(store.loaded).toBe(1)
    expect(store.scans).toBe(1)
    expect(limits.calls).toBe(1)
    service.stop()
  })

  it('scans every 60 s', async () => {
    const { store, service } = make()
    service.start()
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL_MS * 3)
    expect(store.scans).toBe(4)
    service.stop()
  })

  it('polls limits every 5 min, or every 60 s while visible, until the ping expires', async () => {
    const { limits, service } = make()
    service.start()
    expect(limits.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(LIMITS_INTERVAL_MS - 10_000)
    expect(limits.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(limits.calls).toBe(2)

    await vi.advanceTimersByTimeAsync(60_000)
    service.setVisible() // first ping with a stale poll: fetches at once
    await vi.advanceTimersByTimeAsync(0)
    expect(limits.calls).toBe(3)
    // visible for 45 s only, so one more poll at +60 s needs a fresh ping
    await vi.advanceTimersByTimeAsync(30_000)
    service.setVisible()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(limits.calls).toBe(4)
    // pings stop: back to 5 min
    await vi.advanceTimersByTimeAsync(VISIBLE_TTL_MS + 60_000)
    const before = limits.calls
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(limits.calls).toBe(before)
    await vi.advanceTimersByTimeAsync(LIMITS_INTERVAL_MS)
    expect(limits.calls).toBeGreaterThan(before)
    service.stop()
  })

  it('throttles the agent-idle trigger to once per 60 s', async () => {
    const { store, limits, service } = make()
    service.notifyAgentIdle()
    service.notifyAgentIdle()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.scans).toBe(1)
    expect(limits.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(IDLE_THROTTLE_MS)
    service.notifyAgentIdle()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.scans).toBe(2)
    expect(limits.calls).toBe(2)
  })

  it('emits changed only when something visible changed, and bumps dataVersion with data', async () => {
    const { store, limits, service, changed } = make()
    await service.refresh()
    expect(changed).toHaveLength(1) // first state
    await service.refresh()
    expect(changed).toHaveLength(1) // only updatedAt moved
    store.changedNext = true
    await service.refresh()
    expect(changed).toHaveLength(2)
    expect(changed[1].dataVersion).toBe(1)
    limits.data = [
      { account: 'default', configDir: '/c', plan: 'Max', status: 'ok', windows: [], fetchedAt: 1, checkedAt: 1 }
    ]
    await service.refresh()
    expect(changed).toHaveLength(3)
    expect(changed[2].claude[0].plan).toBe('Max')
  })

  it('throttles progress emits to 500 ms and shows indexing only on the first index', async () => {
    const { store, service, changed } = make()
    const step = (n: number): void => {
      store.progress = { filesDone: n, filesTotal: 9, bytesDone: 0, bytesTotal: 1 }
    }
    store.scan = async (onProgress) => {
      store.indexing = true
      step(1)
      onProgress?.(store.progress!)
      step(2)
      onProgress?.(store.progress!)
      await vi.advanceTimersByTimeAsync(PROGRESS_EMIT_MS)
      step(3)
      onProgress?.(store.progress!)
      store.indexing = false
      store.progress = null
      store.lastScanAt = Date.now()
      return false
    }
    await service.refresh()
    const indexing = changed.filter((s) => s.indexing.indexing)
    expect(indexing).toHaveLength(2) // first call and the one after 500 ms; the middle one was dropped
    expect(changed[changed.length - 1].indexing.indexing).toBe(false)
    // a later incremental pass does not flash "indexing"
    changed.length = 0
    store.scan = async (onProgress) => {
      store.indexing = true
      step(1)
      onProgress?.(store.progress!)
      store.indexing = false
      store.progress = null
      return false
    }
    await vi.advanceTimersByTimeAsync(PROGRESS_EMIT_MS)
    await service.refresh()
    expect(changed.some((s) => s.indexing.indexing)).toBe(false)
  })

  it('coalesces concurrent refresh() calls', async () => {
    const { store, limits, service } = make()
    await Promise.all([service.refresh(), service.refresh(), service.refresh()])
    expect(store.scans).toBe(1)
    expect(limits.calls).toBe(1)
  })

  it('stop() clears timers and stops (flushes) the store', async () => {
    const { store, service } = make()
    service.start()
    service.stop()
    const scans = store.scans
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL_MS * 2)
    expect(store.scans).toBe(scans)
    expect(store.stopped).toBe(1)
  })

  it('passes the project key to the store summary', () => {
    const { store, service } = make()
    service.summary('week', '/p')
    expect(store.summary).toHaveBeenCalledWith('week', expect.any(Date), { projectKey: '/p' })
    service.summary('today')
    expect(store.summary).toHaveBeenLastCalledWith('today', expect.any(Date), undefined)
  })
})

describe('UsageState secrets', () => {
  it('never contains the OAuth token', async () => {
    const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE'
    const client = new ClaudeLimitsClient({
      profiles: () => [{ configDir: '/home/u/.claude', label: 'default', isDefault: true }],
      readCredentials: (async () => ({
        ok: true,
        token: TOKEN,
        expiresAt: Date.now() + 3_600_000,
        plan: 'Max'
      })) as never,
      fetch: (async () =>
        new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: '2026-10-23T14:00:00Z' } }), {
          status: 200
        })) as never
    })
    const store = new FakeStore()
    const service = new UsageService({ store, limits: client })
    await service.refresh()
    const state = service.state()
    expect(state.claude[0].windows.length).toBeGreaterThan(0)
    expect(JSON.stringify(state)).not.toContain(TOKEN)
    expect(JSON.stringify(state)).not.toContain('SECRET')
  })
})
