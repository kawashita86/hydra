import { describe, expect, it } from 'vitest'
import type { OverviewEvent } from '@shared/overview/types'
import { eventText, eventsOfAgent, lastWaitFrom } from './historyFacts'

const NOW = 10_000_000
const HOUR = 3_600_000

function ev(at: number, extra: Partial<OverviewEvent> = {}): OverviewEvent {
  return { id: `a@${at}`, at, kind: 'status', agentId: 'a', name: 'alpha', projectDir: '/w', ...extra }
}

describe('lastWaitFrom', () => {
  it('picks the newest needs-you exit within the last hour', () => {
    const events = [
      ev(NOW - HOUR - 1, { from: 'needs-you', to: 'working', waitedMs: 1000 }),
      ev(NOW - 5000, { from: 'needs-you', to: 'working', waitedMs: 2000, name: 'older' }),
      ev(NOW - 1000, { from: 'needs-you', to: 'idle', waitedMs: 3000, name: 'newest' }),
      ev(NOW - 500, { from: 'working', to: 'needs-you' })
    ]
    expect(lastWaitFrom(events, NOW)).toEqual({ name: 'newest', waitedMs: 3000, endedAt: NOW - 1000 })
  })

  it('is undefined when no wait ended in the last hour', () => {
    expect(lastWaitFrom([ev(NOW - HOUR - 1, { from: 'needs-you', waitedMs: 1 })], NOW)).toBeUndefined()
    expect(lastWaitFrom([], NOW)).toBeUndefined()
  })
})

describe('eventsOfAgent and eventText', () => {
  it('keeps one agent, newest first', () => {
    const events = [ev(1), ev(3), ev(2, { agentId: 'b' })]
    expect(eventsOfAgent(events, 'a').map((e) => e.at)).toEqual([3, 1])
  })

  it('describes each kind', () => {
    expect(eventText(ev(1, { from: 'needs-you', to: 'working', waitedMs: 65_000 }))).toBe('Needs you to Working, waited 1m 05s')
    expect(eventText(ev(1, { kind: 'appeared', to: 'idle' }))).toBe('Appeared, idle')
    expect(eventText(ev(1, { kind: 'ended' }))).toBe('Removed from Hydra')
    expect(eventText(ev(1, { kind: 'resumed', gapMs: 600_000 }))).toBe('Watching resumed after 10m')
  })
})
