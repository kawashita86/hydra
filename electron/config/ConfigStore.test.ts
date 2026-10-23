import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_USAGE_SETTINGS } from '@shared/usage/settings'
import { ConfigStore } from './ConfigStore'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'hydra-config-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('ConfigStore usage settings', () => {
  it('defaults the usage block, alerts off', () => {
    expect(new ConfigStore(tmp()).get().usage).toEqual(DEFAULT_USAGE_SETTINGS)
    expect(DEFAULT_USAGE_SETTINGS.alertsEnabled).toBe(false)
  })

  it('reads an old config file without a usage block', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxAgents: 3 }))
    const config = new ConfigStore(dir).get()
    expect(config.maxAgents).toBe(3)
    expect(config.usage).toEqual(DEFAULT_USAGE_SETTINGS)
  })

  it('repairs invalid stored values', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ usage: { alertsEnabled: true, sessionAlertPercent: 5, chipProvider: 'nope' } }))
    expect(new ConfigStore(dir).get().usage).toEqual({ ...DEFAULT_USAGE_SETTINGS, alertsEnabled: true, sessionAlertPercent: 50 })
  })

  it('merges a partial usage patch and validates it', () => {
    const store = new ConfigStore(tmp())
    store.set({ usage: { alertsEnabled: true } as never })
    store.set({ usage: { weeklyAlertPercent: 500 } as never })
    expect(store.get().usage).toEqual({ ...DEFAULT_USAGE_SETTINGS, alertsEnabled: true, weeklyAlertPercent: 100 })
  })
})
