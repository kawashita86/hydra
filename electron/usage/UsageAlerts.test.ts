import { describe, expect, it } from 'vitest'
import type { HydraNotification } from '@shared/types'
import { DEFAULT_USAGE_SETTINGS, type UsageSettings } from '@shared/usage/settings'
import type { LimitWindow, UsageState } from '@shared/usage/types'
import { ALERTS_FILE, UsageAlerts } from './UsageAlerts'

const NOW = Date.parse('2026-10-23T12:00:00Z')

function memoryFs() {
  const files = new Map<string, string>()
  return {
    files,
    readText: (p: string) => files.get(p) ?? null,
    writeAtomic: (p: string, t: string) => void files.set(p, t),
    makeFolder: () => {}
  }
}

function session(usedPercent: number, resetsAt: number): LimitWindow {
  return { provider: 'claude', account: 'default', id: 'session', kind: 'session', label: 'Current session (5h)', usedPercent, resetsAt }
}

function state(windows: LimitWindow[]): UsageState {
  return {
    claude: [{ account: 'default', configDir: '/x', plan: 'Pro', status: 'ok', windows, fetchedAt: NOW, checkedAt: NOW }],
    codex: null,
    indexing: { indexing: false, progress: null, lastScanAt: NOW },
    dataVersion: 0,
    updatedAt: NOW
  }
}

function make(fs = memoryFs(), settings: Partial<UsageSettings> = { alertsEnabled: true }, now = () => NOW) {
  const sent: HydraNotification[] = []
  const alerts = new UsageAlerts({
    dir: '/cache',
    settings: () => ({ ...DEFAULT_USAGE_SETTINGS, ...settings }),
    notify: (n) => sent.push(n),
    runningAgents: () => 2,
    fs,
    now
  })
  return { alerts, sent, fs }
}

describe('UsageAlerts', () => {
  it('does nothing while alerts are off', () => {
    const { alerts, sent, fs } = make(memoryFs(), { alertsEnabled: false })
    alerts.evaluate(state([session(95, NOW + 600_000)]))
    expect(sent).toEqual([])
    expect(fs.files.size).toBe(0)
  })

  it('notifies once per crossing', () => {
    const { alerts, sent } = make()
    const s = state([session(85, NOW + 42 * 60_000)])
    alerts.evaluate(s)
    alerts.evaluate(s)
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('usage_limit')
    expect(sent[0].title).toBe('Claude session limit: 85% used')
    expect(sent[0].body).toContain('Resets in 42 min')
    expect(sent[0].body).toContain('2 Claude agents are running.')
  })

  it('stays quiet below the threshold and uses the configured one', () => {
    const { alerts, sent } = make(memoryFs(), { alertsEnabled: true, sessionAlertPercent: 60 })
    alerts.evaluate(state([session(59, NOW + 1000)]))
    expect(sent).toHaveLength(0)
    alerts.evaluate(state([session(61, NOW + 1000)]))
    expect(sent).toHaveLength(1)
  })

  it('does not repeat after a restart, and re-arms with a new resetsAt', () => {
    const fs = memoryFs()
    const first = make(fs)
    first.alerts.evaluate(state([session(90, NOW + 600_000)]))
    expect(first.sent).toHaveLength(1)
    expect(fs.files.has(`/cache/${ALERTS_FILE}`)).toBe(true)

    const second = make(fs) // a new instance reads alerts.json
    second.alerts.evaluate(state([session(90, NOW + 600_000)]))
    expect(second.sent).toHaveLength(0)
    second.alerts.evaluate(state([session(90, NOW + 6 * 3_600_000)]))
    expect(second.sent).toHaveLength(1)
  })

  it('prunes keys whose window has reset', () => {
    const fs = memoryFs()
    let now = NOW
    const { alerts } = make(fs, { alertsEnabled: true }, () => now)
    alerts.evaluate(state([session(90, NOW + 600_000)]))
    now = NOW + 2 * 3_600_000
    alerts.evaluate(state([session(10, NOW + 6 * 3_600_000)]))
    expect(JSON.parse(fs.files.get(`/cache/${ALERTS_FILE}`) as string).notified).toEqual([])
  })

  it('survives a damaged alerts file', () => {
    const fs = memoryFs()
    fs.files.set(`/cache/${ALERTS_FILE}`, '{nope')
    const { alerts, sent } = make(fs)
    alerts.evaluate(state([session(90, NOW + 600_000)]))
    expect(sent).toHaveLength(1)
  })
})
