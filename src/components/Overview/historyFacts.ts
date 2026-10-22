import type { OverviewEvent } from '@shared/overview/types'
import { formatDuration } from './format'
import { STATUS_LABEL } from './sessionFacts'
import type { LastWait } from './NeedsYouPanel'

const HOUR_MS = 60 * 60 * 1000

/** The newest wait that ended within the last hour (leaving needs-you), `undefined` when none. */
export function lastWaitFrom(events: OverviewEvent[], now: number): LastWait | undefined {
  let best: OverviewEvent | undefined
  for (const e of events) {
    if (e.from !== 'needs-you' || e.waitedMs === undefined || e.at < now - HOUR_MS) continue
    if (!best || e.at > best.at) best = e
  }
  return best && { name: best.name, waitedMs: best.waitedMs as number, endedAt: best.at }
}

/** One line for an event of an agent, without the agent's name. */
export function eventText(e: OverviewEvent): string {
  switch (e.kind) {
    case 'appeared':
      return e.to ? `Appeared, ${STATUS_LABEL[e.to].toLowerCase()}` : 'Appeared'
    case 'ended':
      return 'Removed from Hydra'
    case 'resumed':
      return `Watching resumed after ${formatDuration(e.gapMs ?? 0, { compact: true })}`
    default: {
      const from = e.from ? STATUS_LABEL[e.from] : '?'
      const to = e.to ? STATUS_LABEL[e.to] : '?'
      const waited = e.waitedMs !== undefined ? `, waited ${formatDuration(e.waitedMs)}` : ''
      return `${from} to ${to}${waited}`
    }
  }
}

/** The events of one agent, newest first. */
export function eventsOfAgent(events: OverviewEvent[], agentId: string): OverviewEvent[] {
  return events.filter((e) => e.agentId === agentId).sort((a, b) => b.at - a.at)
}
