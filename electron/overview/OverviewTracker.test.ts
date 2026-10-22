import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '@shared/types'
import type { AgentActivity, OverviewSnapshot } from '@shared/overview/types'
import { STALE_AFTER_MS } from '@shared/overview/status'
import { OverviewTracker } from './OverviewTracker'
import type { RegistryEntry } from './claudeRegistry'

class FakeManager extends EventEmitter {
  agents: AgentState[] = []
  activity = new Map<string, AgentActivity>()
  list = (): AgentState[] => this.agents.map((a) => ({ ...a }))
  getActivity = (id: string): AgentActivity | null => this.activity.get(id) ?? null
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'a1',
    name: 'agent',
    projectDir: '/work/proj',
    provider: 'codex',
    model: 'gpt',
    worktreeBranch: 'feat/x',
    sessionId: null,
    status: 'running',
    pid: 100,
    startedAt: new Date(1_000).toISOString(),
    ...overrides
  } as AgentState
}

describe('OverviewTracker', () => {
  let clock: number
  let manager: FakeManager
  let entries: RegistryEntry[]
  let table: Map<number, number>
  const readRegistry = vi.fn()
  const readTable = vi.fn()
  let tracker: OverviewTracker
  let emitted: OverviewSnapshot[]

  beforeEach(() => {
    vi.useFakeTimers()
    clock = 1_000_000
    manager = new FakeManager()
    entries = []
    table = new Map()
    readRegistry.mockReset().mockImplementation(() => entries)
    readTable.mockReset().mockImplementation(async () => table)
    tracker = new OverviewTracker({
      agentManager: manager,
      registryReader: { read: readRegistry },
      processTableReader: { read: readTable },
      configDirs: () => ['/cfg'],
      now: () => clock
    })
    emitted = []
    tracker.on('snapshot', (s: OverviewSnapshot) => emitted.push(s))
  })

  afterEach(() => {
    tracker.stop()
    vi.useRealTimers()
  })

  it('derives working then idle from output silence for non-Claude agents', async () => {
    manager.agents = [makeAgent()]
    manager.activity.set('a1', { lastOutputAt: clock - 1000, lastExitCode: null })
    let snap = await tracker.refresh()
    expect(snap.sessions[0]).toMatchObject({ status: 'working', startedAt: 1_000, worktreeBranch: 'feat/x' })
    expect(snap.counts.working).toBe(1)

    clock += 10_000
    snap = await tracker.refresh()
    expect(snap.sessions[0].status).toBe('idle')
    expect(snap.sessions[0].statusSince).toBe(clock)
  })

  it('reports a waiting Claude registry entry as needs-you with its reason', async () => {
    manager.agents = [makeAgent({ provider: 'claude', sessionId: 's1' })]
    manager.activity.set('a1', { lastOutputAt: clock, lastExitCode: null })
    entries = [{ file: 'f', configDir: '/cfg', pid: 7, sessionId: 's1', status: 'waiting', waitingFor: 'permission prompt' }]
    const snap = await tracker.refresh()
    expect(snap.sessions[0]).toMatchObject({ status: 'needs-you', waitingReason: 'permission' })
    expect(snap.counts.needsYou).toBe(1)
    expect(readRegistry).toHaveBeenCalledWith(['/cfg'])
  })

  it('keeps statusSince while the status is unchanged', async () => {
    manager.agents = [makeAgent()]
    manager.activity.set('a1', { lastOutputAt: 0, lastExitCode: null })
    const first = await tracker.refresh()
    clock += 60_000
    const second = await tracker.refresh()
    expect(second.sessions[0].status).toBe('idle')
    expect(second.sessions[0].statusSince).toBe(first.sessions[0].statusSince)
  })

  it('flags stale idle sessions and quiet working ones', async () => {
    manager.agents = [makeAgent({ id: 'idle' }), makeAgent({ id: 'quiet', provider: 'claude', sessionId: 'q' })]
    manager.activity.set('idle', { lastOutputAt: 0, lastExitCode: null })
    manager.activity.set('quiet', { lastOutputAt: clock, lastExitCode: null })
    entries = [{ file: 'f', configDir: '/cfg', pid: 7, sessionId: 'q', status: 'busy' }]
    await tracker.refresh()
    clock += STALE_AFTER_MS
    manager.activity.set('quiet', { lastOutputAt: clock - 6 * 60_000, lastExitCode: null })
    const snap = await tracker.refresh()
    const idle = snap.sessions.find((s) => s.agentId === 'idle')
    const quiet = snap.sessions.find((s) => s.agentId === 'quiet')
    expect(idle).toMatchObject({ status: 'idle', stale: true })
    expect(snap.counts.stale).toBe(1)
    expect(quiet?.status).toBe('working')
    expect(quiet?.quietForMs).toBe(6 * 60_000)
  })

  it('maps finished and failed from the process status', async () => {
    manager.agents = [makeAgent({ id: 'f', status: 'idle', pid: null }), makeAgent({ id: 'e', status: 'errored', pid: null })]
    const snap = await tracker.refresh()
    expect(snap.sessions.map((s) => s.status)).toEqual(['finished', 'failed'])
  })

  it('emits only on meaningful changes', async () => {
    tracker.start()
    manager.agents = [makeAgent()]
    manager.activity.set('a1', { lastOutputAt: 0, lastExitCode: null })
    await vi.advanceTimersByTimeAsync(2000)
    const count = emitted.length
    expect(count).toBeGreaterThan(0)

    clock += 30_000
    await vi.advanceTimersByTimeAsync(4000)
    expect(emitted.length).toBe(count)

    manager.activity.set('a1', { lastOutputAt: clock, lastExitCode: null })
    await vi.advanceTimersByTimeAsync(2000)
    expect(emitted.length).toBe(count + 1)
    expect(emitted.at(-1)?.sessions[0].status).toBe('working')
  })

  it('forgets removed agents and restarts their statusSince when they come back', async () => {
    manager.agents = [makeAgent()]
    manager.activity.set('a1', { lastOutputAt: 0, lastExitCode: null })
    await tracker.refresh()
    manager.agents = []
    const empty = await tracker.refresh()
    expect(empty.sessions).toEqual([])
    expect(empty.counts.total).toBe(0)

    clock += 5000
    manager.agents = [makeAgent()]
    const back = await tracker.refresh()
    expect(back.sessions[0].statusSince).toBe(clock)
  })

  it('re-polls shortly after an agent status event', async () => {
    tracker.start()
    await vi.advanceTimersByTimeAsync(0)
    const before = readRegistry.mock.calls.length
    manager.agents = [makeAgent({ provider: 'claude', sessionId: 's' })]
    manager.emit('status', { agentId: 'a1', status: 'running' })
    manager.emit('status', { agentId: 'a1', status: 'running' })
    await vi.advanceTimersByTimeAsync(150)
    expect(readRegistry.mock.calls.length).toBe(before + 1)
    expect(emitted.at(-1)?.sessions).toHaveLength(1)
  })

  it('stops listening and polling after stop()', async () => {
    tracker.start()
    await vi.advanceTimersByTimeAsync(0)
    tracker.stop()
    expect(manager.listenerCount('status')).toBe(0)
    manager.agents = [makeAgent()]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(emitted.at(-1)?.sessions ?? []).toHaveLength(0)
  })

  it('reads the process table only for Claude agents the cheap tiers cannot match', async () => {
    manager.agents = [makeAgent({ provider: 'claude', sessionId: 's1' })]
    manager.activity.set('a1', { lastOutputAt: clock, lastExitCode: null })
    entries = [{ file: 'f', configDir: '/cfg', pid: 7, sessionId: 's1', status: 'busy' }]
    await tracker.refresh()
    expect(readTable).not.toHaveBeenCalled()

    // No sessionId and the registry pid is a child of the agent pid.
    manager.agents = [makeAgent({ provider: 'claude', sessionId: null, pid: 100 })]
    entries = [{ file: 'f', configDir: '/cfg', pid: 205, sessionId: 'x', status: 'waiting', waitingFor: 'input needed' }]
    table = new Map([[205, 150], [150, 100]])
    const snap = await tracker.refresh()
    expect(readTable).toHaveBeenCalledTimes(1)
    expect(snap.sessions[0]).toMatchObject({ status: 'needs-you', waitingReason: 'question' })
  })

  it('does not read the registry or process table when no Claude agent runs', async () => {
    manager.agents = [makeAgent()]
    await tracker.refresh()
    expect(readRegistry).not.toHaveBeenCalled()
    expect(readTable).not.toHaveBeenCalled()
  })

  it('getSnapshot polls once when there is no snapshot yet', async () => {
    manager.agents = [makeAgent()]
    const snap = await tracker.getSnapshot()
    expect(snap.sessions).toHaveLength(1)
    await tracker.getSnapshot()
    expect(readRegistry).not.toHaveBeenCalled()
  })
})
