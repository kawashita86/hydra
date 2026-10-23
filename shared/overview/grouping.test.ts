import { describe, expect, it } from 'vitest'
import { boardColumns, groupByRepo, groupByStatus, NO_REPOSITORY } from './grouping'
import type { OverviewSession } from './types'

function s(id: string, status: OverviewSession['status'], extra: Partial<OverviewSession> = {}): OverviewSession {
  return {
    agentId: id,
    name: id,
    provider: 'claude',
    model: 'sonnet',
    projectDir: `/work/${id}`,
    worktreeBranch: null,
    status,
    statusSince: 0,
    stale: false,
    pid: null,
    startedAt: 0,
    lastOutputAt: 0,
    ...extra
  } as OverviewSession
}

describe('groupByStatus', () => {
  it('orders groups and leaves needs-you out', () => {
    const groups = groupByStatus([
      s('fin', 'finished'),
      s('start', 'starting'),
      s('need', 'needs-you'),
      s('stale', 'idle', { stale: true }),
      s('idle', 'idle'),
      s('fail', 'failed'),
      s('work', 'working'),
      s('nr', 'not-running')
    ])
    expect(groups.map((g) => g.label)).toEqual([
      'Working',
      'Idle',
      'Finished / Failed',
      'Not running',
      'Starting'
    ])
    expect(groups[1].sessions.map((x) => x.agentId)).toEqual(['idle', 'stale'])
    expect(groups[2].sessions.map((x) => x.agentId)).toEqual(['fail', 'fin'])
    expect(groups.flatMap((g) => g.sessions).some((x) => x.agentId === 'need')).toBe(false)
  })

  it('drops empty groups and puts the longest in status first', () => {
    const groups = groupByStatus([s('b', 'working', { statusSince: 20 }), s('a', 'working', { statusSince: 10 })])
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((x) => x.agentId)).toEqual(['a', 'b'])
  })
})

describe('groupByRepo', () => {
  it('sorts repositories, puts "No repository" last and keeps status order', () => {
    const repo = (x: OverviewSession) => ({ a: 'zeta', b: 'alpha', c: 'alpha' })[x.agentId] ?? null
    const groups = groupByRepo([s('a', 'working'), s('c', 'idle'), s('b', 'working'), s('d', 'finished')], repo)
    expect(groups.map((g) => g.label)).toEqual(['alpha', 'zeta', NO_REPOSITORY])
    expect(groups[0].sessions.map((x) => x.agentId)).toEqual(['b', 'c'])
  })
})

describe('boardColumns', () => {
  it('caps columns, counts hidden and separates stale idle', () => {
    const many = Array.from({ length: 7 }, (_, i) => s(`w${i}`, 'working'))
    const idles = [s('i1', 'idle', { stale: true }), s('i2', 'idle')]
    const cols = boardColumns([...many, ...idles, s('n', 'needs-you'), s('f', 'failed'), s('x', 'finished'), s('nr', 'not-running')])
    const by = Object.fromEntries(cols.map((c) => [c.key, c]))
    expect(by.working.items).toHaveLength(5)
    expect(by.working.hidden).toBe(2)
    expect(by.idle.items.map((x) => x.agentId)).toEqual(['i2', 'i1'])
    expect(by.idle.stale).toBe(1)
    expect(by['needs-you'].total).toBe(1)
    expect(by.ended.items.map((x) => x.agentId)).toEqual(['f', 'x'])
    expect(cols.flatMap((c) => c.items).some((x) => x.agentId === 'nr')).toBe(false)
  })
})
