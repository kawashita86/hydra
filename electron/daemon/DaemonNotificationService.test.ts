import { EventEmitter } from 'events'
import { describe, expect, it } from 'vitest'
import type { AgentManager } from '../agents/AgentManager'
import type { HeadlessOrchestrator } from '../headless/HeadlessOrchestrator'
import type { HydraNotification } from '@shared/types'
import type { OverviewEvent, OverviewSession, OverviewSnapshot } from '@shared/overview/types'
import { DaemonNotificationService } from './DaemonNotificationService'

class FakeTracker extends EventEmitter {
  snapshot: OverviewSnapshot | null = null
  matched = new Set<string>()
  peekSnapshot(): OverviewSnapshot | null {
    return this.snapshot
  }
  hasRegistryMatch(id: string): boolean {
    return this.matched.has(id)
  }
}

function session(over: Partial<OverviewSession>): OverviewSession {
  return {
    agentId: 'a1',
    name: 'api',
    provider: 'claude',
    projectDir: '/p',
    status: 'needs-you',
    ...over
  } as OverviewSession
}

function enterEvent(over: Partial<OverviewEvent> = {}): OverviewEvent {
  return {
    id: 'a1@1:status',
    at: 1,
    kind: 'status',
    agentId: 'a1',
    name: 'api',
    projectDir: '/p',
    from: 'working',
    to: 'needs-you',
    ...over
  }
}

function setup() {
  const service = new DaemonNotificationService()
  const tracker = new FakeTracker()
  const manager = new EventEmitter() as EventEmitter & { get: (id: string) => unknown }
  const providers: Record<string, string> = { a1: 'claude', c1: 'codex' }
  manager.get = (id) => ({ id, name: id === 'a1' ? 'api' : id, provider: providers[id] })
  const headless = new EventEmitter()
  service.connectAgentEvents(manager as unknown as AgentManager, headless as unknown as HeadlessOrchestrator)
  service.connectOverviewEvents(tracker)
  const pushed: HydraNotification[] = []
  service.subscribe((n) => pushed.push(n))
  return { tracker, manager, pushed }
}

describe('needs-you notifications', () => {
  it('maps a permission wait with its text', () => {
    const { tracker, pushed } = setup()
    tracker.snapshot = { sessions: [session({ waitingReason: 'permission', waitingText: 'Run: npm test' })] } as OverviewSnapshot
    tracker.emit('events', [enterEvent()])
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({
      type: 'agent_waiting',
      title: 'Needs you',
      body: 'api needs permission: Run: npm test',
      agentId: 'a1'
    })
  })

  it('maps a question and the generic wait', () => {
    const { tracker, pushed } = setup()
    tracker.snapshot = { sessions: [session({ waitingReason: 'question' })] } as OverviewSnapshot
    tracker.emit('events', [enterEvent()])
    tracker.snapshot = { sessions: [session({ waitingReason: 'other' })] } as OverviewSnapshot
    tracker.emit('events', [enterEvent()])
    expect(pushed.map((n) => n.body)).toEqual(['api asked a question', 'api is waiting for you'])
  })

  it('ignores other events', () => {
    const { tracker, pushed } = setup()
    tracker.emit('events', [enterEvent({ from: 'needs-you', to: 'working' }), enterEvent({ kind: 'appeared', to: 'working' })])
    expect(pushed).toHaveLength(0)
  })
})

describe('5 s silence heuristic', () => {
  it('is suppressed for a Claude agent matched to the registry', () => {
    const { tracker, manager, pushed } = setup()
    tracker.matched.add('a1')
    manager.emit('agent_waiting', { agentId: 'a1' })
    expect(pushed).toHaveLength(0)
  })

  it('is kept for an unmatched Claude agent', () => {
    const { manager, pushed } = setup()
    manager.emit('agent_waiting', { agentId: 'a1' })
    expect(pushed).toHaveLength(1)
    expect(pushed[0].title).toBe('Agent Finished')
  })

  it('is kept for other providers even if the id is matched', () => {
    const { tracker, manager, pushed } = setup()
    tracker.matched.add('c1')
    manager.emit('agent_waiting', { agentId: 'c1' })
    expect(pushed).toHaveLength(1)
  })
})
