import { randomUUID } from 'crypto'
import { join } from 'path'
import { alertableWindows, describeAlert, dueAlerts } from '@shared/usage/alerts'
import type { UsageSettings } from '@shared/usage/settings'
import type { UsageProvider, UsageState } from '@shared/usage/types'
import type { HydraNotification } from '@shared/types'
import { nodeUsageFs, type UsageFs } from './usageFiles'

export const ALERTS_FILE = 'alerts.json'
const MAX_ALERTS_BYTES = 256 * 1024

export interface UsageAlertsOptions {
  /** The usage cache folder (`<userData>/usage-cache`). */
  dir: string
  settings: () => UsageSettings
  notify: (notification: HydraNotification) => void
  /** Running agents of a provider, for the notification text. Optional. */
  runningAgents?: (provider: UsageProvider) => number
  fs?: Pick<UsageFs, 'readText' | 'writeAtomic' | 'makeFolder'>
  now?: () => number
}

/**
 * Opt-in low-limit notifications. One per (provider, account, window, resetsAt, threshold); the keys
 * are kept in `alerts.json` so a restart does not repeat them. A new `resetsAt` re-arms a window.
 */
export class UsageAlerts {
  private readonly opts: UsageAlertsOptions
  private readonly fs: Pick<UsageFs, 'readText' | 'writeAtomic' | 'makeFolder'>
  private readonly now: () => number
  /** key -> resetsAt of the window it belongs to (for pruning). */
  private notified: Map<string, number> | null = null

  constructor(opts: UsageAlertsOptions) {
    this.opts = opts
    this.fs = opts.fs ?? nodeUsageFs
    this.now = opts.now ?? Date.now
  }

  /** Notifies every due alert of `state`; does nothing while alerts are off. */
  evaluate(state: UsageState): void {
    const settings = this.opts.settings()
    if (!settings.alertsEnabled) return
    const now = this.now()
    const known = this.load()
    const due = dueAlerts(alertableWindows(state, now), settings, new Set(known.keys()), now)
    let changed = this.prune(known, now)
    for (const alert of due) {
      known.set(alert.key, alert.window.resetsAt as number)
      changed = true
      let running: number | undefined
      try {
        running = this.opts.runningAgents?.(alert.window.provider)
      } catch {
        running = undefined
      }
      const { title, body } = describeAlert(alert.window, now, running)
      try {
        this.opts.notify({
          id: randomUUID().slice(0, 12),
          type: 'usage_limit',
          title,
          body,
          timestamp: new Date(now).toISOString()
        })
      } catch {
        /* best-effort delivery */
      }
    }
    if (changed) this.save(known)
  }

  private prune(known: Map<string, number>, now: number): boolean {
    let changed = false
    for (const [key, resetsAt] of known) {
      if (resetsAt <= now) {
        known.delete(key)
        changed = true
      }
    }
    return changed
  }

  private load(): Map<string, number> {
    if (this.notified) return this.notified
    const map = new Map<string, number>()
    try {
      const text = this.fs.readText(join(this.opts.dir, ALERTS_FILE), MAX_ALERTS_BYTES)
      const parsed: unknown = text ? JSON.parse(text) : null
      const list = (parsed as { notified?: unknown } | null)?.notified
      if (Array.isArray(list)) {
        for (const e of list) {
          if (e && typeof e.key === 'string' && typeof e.resetsAt === 'number') map.set(e.key, e.resetsAt)
        }
      }
    } catch {
      /* a missing or damaged file starts empty */
    }
    this.notified = map
    return map
  }

  private save(known: Map<string, number>): void {
    try {
      this.fs.makeFolder(this.opts.dir)
      const notified = [...known].map(([key, resetsAt]) => ({ key, resetsAt }))
      this.fs.writeAtomic(join(this.opts.dir, ALERTS_FILE), JSON.stringify({ version: 1, notified }))
    } catch {
      /* the alerts still work for this run */
    }
  }
}
