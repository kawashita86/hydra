import { describe, expect, it, vi } from 'vitest'
import type { HistoryPoint, OverviewEvent } from '@shared/overview/types'
import type { HistoryFs, PathInfo } from './historyFiles'
import {
  HistoryStore,
  MAX_EVENTS,
  MAX_FILE_BYTES,
  MAX_POINTS,
  filesToDelete,
  parseHistoryFileName
} from './HistoryStore'

const DIR = '/h'
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-10-22T10:00:00.000Z')

/** A folder in memory. `others` are names that exist but are not ordinary files (links, pipes). */
class MemoryFs implements HistoryFs {
  files = new Map<string, string>()
  others = new Set<string>()
  folders: string[] = []
  failAppends = false
  private name(file: string): string {
    return file.slice(DIR.length + 1)
  }
  makeFolder(dir: string): void {
    this.folders.push(dir)
  }
  list(): string[] {
    return [...this.files.keys(), ...this.others]
  }
  stat(file: string): PathInfo | null {
    const n = this.name(file)
    if (this.others.has(n)) return { kind: 'other', size: 0 }
    const content = this.files.get(n)
    return content === undefined ? null : { kind: 'file', size: content.length }
  }
  read(file: string, maxBytes: number): string {
    const n = this.name(file)
    const content = this.files.get(n)
    if (content === undefined || content.length > maxBytes) throw new Error('unreadable')
    return content
  }
  append(file: string, text: string): void {
    if (this.failAppends) throw new Error('disk full')
    const n = this.name(file)
    if (this.others.has(n)) throw new Error('not ordinary')
    this.files.set(n, (this.files.get(n) ?? '') + text)
  }
  remove(file: string): void {
    this.files.delete(this.name(file))
  }
}

function point(at: number, extra: Partial<HistoryPoint> = {}): HistoryPoint {
  return { at, needsYou: 0, working: 1, idle: 0, total: 1, statuses: { a: 'working' }, ...extra }
}

function event(at: number, extra: Partial<OverviewEvent> = {}): OverviewEvent {
  return { id: `a@${at}:status`, at, kind: 'status', agentId: 'a', name: 'alpha', projectDir: '/w', ...extra }
}

function setup(fs: MemoryFs, now = T0, extra: { restoreBudgetMs?: number; budgetClock?: () => number } = {}) {
  let clock = now
  const store = new HistoryStore({ dir: DIR, fs, now: () => clock, ...extra })
  return {
    store,
    setClock: (t: number) => {
      clock = t
    }
  }
}

const lines = (fs: MemoryFs, name: string): string[] => (fs.files.get(name) ?? '').split('\n').filter(Boolean)

describe('HistoryStore memory', () => {
  it('keeps at most 1000 events and 4320 points', () => {
    const { store } = setup(new MemoryFs())
    store.start()
    store.addEvents(Array.from({ length: MAX_EVENTS + 5 }, (_, i) => event(T0 + i)))
    for (let i = 0; i < MAX_POINTS + 3; i++) store.addPoint(point(T0 + i * 5000))
    const res = store.query(0)
    expect(res.events).toHaveLength(MAX_EVENTS)
    expect(res.events[0].at).toBe(T0 + 5)
    expect(res.points).toHaveLength(MAX_POINTS)
    expect(res.since).toBe(res.points[0].at) // older points were dropped, so the history begins here
  })

  it('answers from a time on, with names of the agents it mentions', () => {
    const { store } = setup(new MemoryFs())
    store.start()
    store.addPoint(point(T0 + 1000, { statuses: { a: 'working', gone: 'idle' } }), {
      a: { name: 'alpha', projectDir: '/w' },
      gone: { name: 'old', projectDir: '/o' },
      unrelated: { name: 'zzz', projectDir: '/z' }
    })
    store.addPoint(point(T0 + 6000), {})
    const res = store.query(T0 + 2000)
    expect(res.points.map((p) => p.at)).toEqual([T0 + 6000])
    expect(Object.keys(res.agents)).toEqual(['a'])
    expect(res.startedAt).toBe(T0)
    expect(res.starts).toEqual([])
    expect(store.query(0).starts).toEqual([T0])
    expect(store.lastPointAt()).toBe(T0 + 6000)
  })
})

describe('HistoryStore on disk', () => {
  it('writes a start record, points and events, flushing on stop', () => {
    const fs = new MemoryFs()
    const { store } = setup(fs)
    store.start()
    store.addPoint(point(T0 + 5000))
    store.addEvents([event(T0 + 5000, { from: 'working', to: 'idle' })])
    store.stop()
    expect(fs.folders).toEqual([DIR])
    expect(lines(fs, 'v1-2026-10-22.jsonl')).toEqual([
      `{"start":${T0}}`,
      `{"point":[${T0 + 5000},0,1,0,1,{"a":"working"}]}`,
      `{"event":{"id":"a@${T0 + 5000}:status","at":${T0 + 5000},"kind":"status","agentId":"a","name":"alpha","projectDir":"/w","from":"working","to":"idle"}}`
    ])
  })

  it('writes events field by field', () => {
    const fs = new MemoryFs()
    const { store } = setup(fs)
    store.start()
    store.addEvents([{ ...event(T0 + 1), waitingText: 'Run: rm -rf /' } as OverviewEvent])
    store.stop()
    expect(fs.files.get('v1-2026-10-22.jsonl')).not.toContain('rm -rf')
  })

  it('flushes on the interval, not on every add', () => {
    vi.useFakeTimers()
    try {
      const fs = new MemoryFs()
      const store = new HistoryStore({ dir: DIR, fs, now: () => T0, flushIntervalMs: 5000 })
      store.start()
      store.addPoint(point(T0))
      expect(lines(fs, 'v1-2026-10-22.jsonl')).toHaveLength(1) // only the start record
      vi.advanceTimersByTime(5000)
      expect(lines(fs, 'v1-2026-10-22.jsonl')).toHaveLength(2)
      store.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the newest events and points, and records the start', () => {
    const fs = new MemoryFs()
    const first = setup(fs)
    first.store.start()
    first.store.addEvents([event(T0 + 1000, { to: 'idle' })])
    first.store.addPoint(point(T0 + 5000), { a: { name: 'alpha', projectDir: '/w' } })
    first.store.stop()

    const second = setup(fs, T0 + 60_000)
    second.store.start()
    const res = second.store.query(0)
    expect(res.points.map((p) => p.at)).toEqual([T0 + 5000])
    expect(res.points[0].statuses).toEqual({ a: 'working' })
    expect(res.events.map((e) => e.at)).toEqual([T0 + 1000])
    expect(res.starts).toEqual([T0, T0 + 60_000])
    expect(res.startedAt).toBe(T0 + 60_000)
    expect(res.since).toBe(T0) // the first record restored
    expect(res.agents.a).toEqual({ name: 'alpha', projectDir: '/w' })
    expect(second.store.lastPointAt()).toBe(T0 + 5000)
    expect(lines(fs, 'v1-2026-10-22.jsonl').pop()).toBe(`{"start":${T0 + 60_000}}`)
  })

  it('skips malformed lines and records dated more than a minute ahead', () => {
    const fs = new MemoryFs()
    const good = `{"point":[${T0 - 5000},0,1,0,1,{"a":"working"}]}`
    fs.files.set(
      'v1-2026-10-22.jsonl',
      [
        '{"start":',
        'not json',
        good,
        `{"point":[${T0 + 30_000},0,1,0,1,{}]}`, // within the minute: kept
        `{"point":[${T0 + 120_000},0,1,0,1,{}]}`, // future: dropped
        '{"point":["x",0,1,0,1]}',
        '{"point":[1,2]}',
        '{"event":{"id":"x"}}',
        `{"event":{"id":"e","at":${T0 - 1},"kind":"bogus","agentId":"a","name":"n","projectDir":"p"}}`,
        `{"event":{"id":"e","at":${T0 - 1},"kind":"appeared","agentId":"a","name":"n","projectDir":"p","to":"nope"}}`,
        '{"other":1}',
        'null',
        ''
      ].join('\n')
    )
    const { store } = setup(fs)
    store.start()
    const res = store.query(0)
    expect(res.points.map((p) => p.at)).toEqual([T0 - 5000, T0 + 30_000])
    expect(res.events).toEqual([
      { id: 'e', at: T0 - 1, kind: 'appeared', agentId: 'a', name: 'n', projectDir: 'p' }
    ])
  })

  it('does not read other formats, links, other file types or oversize files', () => {
    const fs = new MemoryFs()
    const rec = (at: number): string => `{"point":[${at},0,1,0,1,{}]}\n`
    fs.files.set('v2-2026-10-22.jsonl', rec(T0 - 1000))
    fs.files.set('notes.txt', rec(T0 - 2000))
    fs.files.set('v1-2026-10-21.jsonl', rec(T0 - 3000) + ' '.repeat(2 * MAX_FILE_BYTES + 1))
    fs.others.add('v1-2026-10-20.jsonl')
    fs.files.set('v1-2026-10-19.jsonl', rec(T0 - 4000))
    const { store } = setup(fs)
    store.start()
    expect(store.query(0).points.map((p) => p.at)).toEqual([T0 - 4000])
    expect(fs.files.has('v2-2026-10-22.jsonl')).toBe(true)
    expect(fs.files.has('notes.txt')).toBe(true)
  })

  it('stops restoring when the time budget is spent', () => {
    const fs = new MemoryFs()
    for (let d = 0; d < 4; d++) {
      fs.files.set(`v1-2026-10-${String(22 - d).padStart(2, '0')}.jsonl`, `{"point":[${T0 - d * DAY},0,1,0,1,{}]}\n`)
    }
    let tick = 0
    const { store } = setup(fs, T0, { restoreBudgetMs: 10_000, budgetClock: () => (tick += 4000) })
    store.start()
    // deadline is 4000 + 10000: checks at 8000 and 12000 pass, 16000 does not.
    expect(store.query(0).points).toHaveLength(2)
  })

  it('starts the first write to a non-empty file with a line break', () => {
    const fs = new MemoryFs()
    fs.files.set('v1-2026-10-22.jsonl', '{"point":[1,0,0')
    const { store } = setup(fs)
    store.start()
    store.addPoint(point(T0 + 1))
    store.stop()
    const text = fs.files.get('v1-2026-10-22.jsonl') as string
    expect(text.startsWith('{"point":[1,0,0\n{"start":')).toBe(true)
    expect(text.split('\n').filter((l) => l.startsWith('\n'))).toEqual([])
    expect(text).not.toContain('\n\n')
  })

  it('rolls over to -2 past 2 MB and goes on in the next day', () => {
    const fs = new MemoryFs()
    fs.files.set('v1-2026-10-22.jsonl', ' '.repeat(MAX_FILE_BYTES - 10) + '\n')
    const { store, setClock } = setup(fs)
    store.start()
    store.addPoint(point(T0 + 1000))
    store.stop()
    expect(fs.files.get('v1-2026-10-22.jsonl')).toHaveLength(MAX_FILE_BYTES - 9)
    expect(lines(fs, 'v1-2026-10-22-2.jsonl')).toHaveLength(2) // start (after restore) and the point

    setClock(T0 + DAY)
    store.addPoint(point(T0 + DAY))
    store.flush()
    expect(lines(fs, 'v1-2026-10-23.jsonl')).toHaveLength(1)
  })

  it('writes in the next file when the day file is not an ordinary file', () => {
    const fs = new MemoryFs()
    fs.others.add('v1-2026-10-22.jsonl')
    const { store } = setup(fs)
    store.start()
    store.stop()
    expect(lines(fs, 'v1-2026-10-22-2.jsonl')).toEqual([`{"start":${T0}}`])
  })

  it('keeps the lines when a write fails and writes them on the next flush', () => {
    const fs = new MemoryFs()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { store } = setup(fs)
    fs.failAppends = true
    store.start()
    store.addPoint(point(T0 + 1))
    store.flush()
    fs.failAppends = false
    store.flush()
    expect(lines(fs, 'v1-2026-10-22.jsonl')).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('deletes days that ended more than 8 days ago before writing', () => {
    const fs = new MemoryFs()
    fs.files.set('v1-2026-10-13.jsonl', 'x\n') // ended Oct 14 00:00, 8d 10h before now
    fs.files.set('v1-2026-10-14.jsonl', 'y\n') // ended Oct 15 00:00, 7d 10h ago
    fs.files.set('v2-2026-10-01.jsonl', 'z\n')
    const { store } = setup(fs)
    store.start()
    expect([...fs.files.keys()].sort()).toEqual(['v1-2026-10-14.jsonl', 'v1-2026-10-22.jsonl', 'v2-2026-10-01.jsonl'])
  })
})

describe('HistoryStore status deltas', () => {
  const FILE = 'v1-2026-10-22.jsonl'
  const many = (n: number, over: Record<string, 'working' | 'idle' | 'needs-you'> = {}) => ({
    ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`agent-${i}`, 'working' as const])),
    ...over
  })

  it('writes the full map first, then only what changed, and restores full maps', () => {
    const fs = new MemoryFs()
    const first = setup(fs)
    first.store.start()
    first.store.addPoint(point(T0 + 1000, { statuses: many(3) }))
    first.store.addPoint(point(T0 + 2000, { statuses: many(3) }))
    first.store.addPoint(point(T0 + 3000, { statuses: many(3, { 'agent-1': 'idle' }) }))
    const gone = many(3, { 'agent-1': 'idle' })
    delete (gone as Record<string, string>)['agent-0']
    first.store.addPoint(point(T0 + 4000, { statuses: gone }))
    first.store.stop()

    const written = lines(fs, FILE).filter((l) => l.startsWith('{"point"'))
    expect(written[1]).toBe(`{"point":[${T0 + 2000},0,1,0,1,{},1]}`)
    expect(written[2]).toBe(`{"point":[${T0 + 3000},0,1,0,1,{"agent-1":"idle"},1]}`)
    expect(written[3]).toBe(`{"point":[${T0 + 4000},0,1,0,1,{"agent-0":null},1]}`)

    const second = setup(fs, T0 + 60_000)
    second.store.start()
    const points = second.store.query(0).points
    expect(points.map((p) => p.statuses)).toEqual([
      many(3),
      many(3),
      many(3, { 'agent-1': 'idle' }),
      gone
    ])
  })

  it('writes a full point at the start of each run and of each new file', () => {
    const fs = new MemoryFs()
    const a = setup(fs)
    a.store.start()
    a.store.addPoint(point(T0 + 1000, { statuses: many(2) }))
    a.store.stop()
    const b = setup(fs, T0 + 10_000)
    b.store.start()
    b.store.addPoint(point(T0 + 11_000, { statuses: many(2) }))
    b.store.flush()
    b.setClock(T0 + DAY)
    b.store.addPoint(point(T0 + DAY, { statuses: many(2) }))
    b.store.flush()
    const full = (name: string) => lines(fs, name).filter((l) => l.startsWith('{"point"') && !l.endsWith(',1]}'))
    expect(full(FILE)).toHaveLength(2) // first point of each run
    expect(lines(fs, FILE).filter((l) => l.endsWith(',1]}'))).toHaveLength(0)
    expect(full('v1-2026-10-23.jsonl')).toHaveLength(1)
  })

  it('restores a file that starts mid-run on its own and skips deltas that have no full point before them', () => {
    const fs = new MemoryFs()
    fs.files.set(
      'v1-2026-10-21.jsonl',
      [
        `{"point":[${T0 - DAY + 1000},0,1,0,1,{"a":"idle"},1]}`, // delta first: nothing to apply it to
        `{"point":[${T0 - DAY + 2000},0,1,0,1,{"a":"working","b":"idle"}]}`,
        `{"point":[${T0 - DAY + 3000},0,1,0,1,{"b":null,"c":"nope"},1]}`
      ].join('\n') + '\n'
    )
    fs.files.set('v1-2026-10-22.jsonl', `{"point":[${T0 - 1000},0,1,0,1,{"x":"idle"},1]}\n{"point":[${T0 - 500},0,1,0,1,{"x":"working"}]}\n`)
    const { store } = setup(fs)
    store.start()
    expect(store.query(0).points.map((p) => [p.at, p.statuses])).toEqual([
      [T0 - DAY + 2000, { a: 'working', b: 'idle' }],
      [T0 - DAY + 3000, { a: 'working' }],
      [T0 - 500, { x: 'working' }]
    ])
  })

  it('costs about the same per point with 10 unchanged agents', () => {
    const fs = new MemoryFs()
    const { store } = setup(fs)
    store.start()
    store.flush()
    const before = (fs.files.get(FILE) as string).length
    for (let i = 1; i <= 100; i++) store.addPoint(point(T0 + i * 5000, { statuses: many(10) }))
    store.flush()
    const perPoint = ((fs.files.get(FILE) as string).length - before) / 100
    expect(perPoint).toBeLessThan(60) // a full map of 10 uuid-sized ids would be ~400 bytes
    const mem = store.query(0).points
    expect(Object.keys(mem[99].statuses)).toHaveLength(10)
  })

  it('leaves agents finished or failed for over an hour out of what is written, not out of memory', () => {
    const fs = new MemoryFs()
    const { store } = setup(fs)
    store.start()
    const st = { run: 'working', done: 'finished', bad: 'failed' } as const
    store.addPoint(point(T0, { statuses: { ...st } }))
    store.addPoint(point(T0 + 60 * 60 * 1000 + 1, { statuses: { ...st } }))
    store.flush()
    const written = lines(fs, FILE).filter((l) => l.startsWith('{"point"'))
    expect(written[0]).toContain('"done":"finished"')
    expect(written[1]).toBe(`{"point":[${T0 + 3_600_001},0,1,0,1,{"done":null,"bad":null},1]}`)
    expect(Object.keys(store.query(0).points[1].statuses)).toHaveLength(3)
  })

  it('does not write not-running agents to disk, but keeps them in memory', () => {
    const fs = new MemoryFs()
    const { store } = setup(fs)
    store.start()
    store.addPoint(point(T0, { statuses: { run: 'working', stopped: 'not-running' } }))
    store.flush()
    const written = lines(fs, FILE).filter((l) => l.startsWith('{"point"'))
    expect(written[0]).toContain('"run":"working"')
    expect(written[0]).not.toContain('stopped')
    expect(Object.keys(store.query(0).points[0].statuses)).toHaveLength(2)
  })
})

describe('HistoryStore wait ledger', () => {
  const dayFile = (offsetDays: number): string => `v1-${new Date(T0 + offsetDays * DAY).toISOString().slice(0, 10)}.jsonl`
  const full = (at: number, statuses = '{"a":"working"}') => `{"point":[${at},0,1,0,1,${statuses}]}`
  const delta = (at: number) => `{"point":[${at},0,1,0,1,{},1]}`
  const move = (at: number, from: string, to: string) =>
    `{"event":{"id":"a@${at}:status","at":${at},"kind":"status","agentId":"a","name":"alpha","projectDir":"/w","from":"${from}","to":"${to}"}}`

  it('seeds transitions and spans from delta points, breaking at gaps and at starts', () => {
    const fs = new MemoryFs()
    const t = T0 - 3 * DAY
    fs.files.set(
      dayFile(-3),
      [
        `{"start":${t}}`,
        full(t),
        delta(t + 5000),
        delta(t + 10_000),
        move(t + 10_000, 'working', 'needs-you'),
        delta(t + 70_000), // 60 s gap: a new span
        move(t + 72_000, 'needs-you', 'working'),
        delta(t + 75_000),
        `{"start":${t + 77_000}}`, // a start breaks the span however soon the next point comes
        full(t + 78_000)
      ].join('\n')
    )
    const { store } = setup(fs)
    store.start()
    const ledger = store.waits()
    expect(ledger.spans).toEqual([
      { start: t, end: t + 10_000 },
      { start: t + 70_000, end: t + 75_000 },
      { start: t + 78_000, end: t + 78_000 }
    ])
    expect(ledger.transitions.map((x) => [x.direction, x.at, x.agentId, x.name, x.projectDir])).toEqual([
      ['in', t + 10_000, 'a', 'alpha', '/w'],
      ['out', t + 72_000, 'a', 'alpha', '/w']
    ])
    expect(ledger.starts).toEqual([t, t + 77_000, T0])
  })

  it('joins a stretch that goes on in the next day\'s file', () => {
    const fs = new MemoryFs()
    const midnight = Date.parse('2026-10-20T00:00:00.000Z')
    fs.files.set('v1-2026-10-19.jsonl', [`{"start":${midnight - 20_000}}`, full(midnight - 10_000), delta(midnight - 5000)].join('\n'))
    fs.files.set('v1-2026-10-20.jsonl', [full(midnight + 2000), delta(midnight + 7000)].join('\n'))
    const { store } = setup(fs)
    store.start()
    expect(store.waits().spans).toEqual([{ start: midnight - 10_000, end: midnight + 7000 }])
  })

  it('holds more than the rings: old events and points still reach the ledger', () => {
    const fs = new MemoryFs()
    const old = T0 - 2 * DAY
    fs.files.set(
      dayFile(-2),
      [`{"start":${old}}`, full(old), delta(old + 5000), move(old + 5000, 'working', 'needs-you'), move(old + 9000, 'needs-you', 'idle'), delta(old + 10_000)].join('\n')
    )
    const recent: string[] = [`{"start":${T0 - 3 * 3600_000}}`]
    for (let i = 0; i < MAX_POINTS + 10; i++) recent.push(i === 0 ? full(T0 - 3 * 3600_000 + 1) : delta(T0 - 3 * 3600_000 + 1 + i * 2))
    for (let i = 0; i < MAX_EVENTS + 10; i++) recent.push(move(T0 - 3 * 3600_000 + 2 + i, 'working', 'idle'))
    fs.files.set(dayFile(0), recent.join('\n'))
    const { store } = setup(fs)
    store.start()

    const rings = store.query(0)
    expect(rings.events).toHaveLength(MAX_EVENTS)
    expect(rings.events.every((e) => e.at > old + DAY)).toBe(true)
    expect(rings.since).toBeGreaterThan(old + DAY) // the rings begin where they did before

    const ledger = store.waits()
    expect(ledger.transitions.map((x) => [x.direction, x.at])).toEqual([
      ['in', old + 5000],
      ['out', old + 9000]
    ])
    expect(ledger.spans[0]).toEqual({ start: old, end: old + 10_000 })
    // The recent run is one span although its older points were not kept in the ring.
    expect(ledger.spans[1].start).toBe(T0 - 3 * 3600_000 + 1)
    expect(ledger.spans[1].end).toBe(T0 - 3 * 3600_000 + 1 + (MAX_POINTS + 9) * 2)
  })

  it('skips malformed lines and the future', () => {
    const fs = new MemoryFs()
    fs.files.set(
      dayFile(0),
      ['not json', `{"point":[${T0 - 10_000},0,1,0,1,{"a":"working"}]}`, `{"point":[${T0 - 5000},0,1,0,1,{}`, `{"point":[${T0 + 3_600_000},0,1,0,1,{}]}`].join('\n')
    )
    const { store } = setup(fs)
    store.start()
    expect(store.waits().spans).toEqual([{ start: T0 - 10_000, end: T0 - 10_000 }])
  })

  it('is fed live: events become transitions and points extend the stretch', () => {
    const { store } = setup(new MemoryFs())
    store.start()
    store.addPoint(point(T0 + 1000))
    store.addEvents([
      event(T0 + 2000, { from: 'working', to: 'needs-you' }),
      event(T0 + 2500, { from: 'working', to: 'idle' }),
      event(T0 + 3000, { kind: 'ended', from: 'needs-you' })
    ])
    store.addPoint(point(T0 + 6000))
    store.addPoint(point(T0 + 11_000))
    store.addPoint(point(T0 + 60_000)) // gap
    const ledger = store.waits()
    expect(ledger.spans).toEqual([
      { start: T0 + 1000, end: T0 + 11_000 },
      { start: T0 + 60_000, end: T0 + 60_000 }
    ])
    expect(ledger.transitions.map((x) => x.direction)).toEqual(['in', 'out'])
    expect(ledger.starts).toEqual([T0])
  })

  it('does not join the first point of a run to the last of the previous one', () => {
    const fs = new MemoryFs()
    const first = setup(fs)
    first.store.start()
    first.store.addPoint(point(T0 + 1000))
    first.store.stop()
    const second = setup(fs, T0 + 3000)
    second.store.start()
    second.store.addPoint(point(T0 + 4000))
    expect(second.store.waits().spans).toEqual([
      { start: T0 + 1000, end: T0 + 1000 },
      { start: T0 + 4000, end: T0 + 4000 }
    ])
  })

  it('prunes what is older than 9 days, on restore and later', () => {
    const fs = new MemoryFs()
    const ancient = T0 - 10 * DAY
    fs.files.set(
      dayFile(-10),
      [`{"start":${ancient}}`, full(ancient), delta(ancient + 5000), move(ancient + 5000, 'working', 'needs-you'), move(ancient + 8000, 'needs-you', 'idle')].join('\n')
    )
    const edge = T0 - 9 * DAY + 60_000
    fs.files.set(dayFile(-9), [`{"start":${edge}}`, full(edge), delta(edge + 5000), move(edge + 2000, 'working', 'needs-you')].join('\n'))
    const { store, setClock } = setup(fs)
    store.start()
    let ledger = store.waits()
    expect(ledger.transitions.map((x) => x.at)).toEqual([edge + 2000])
    expect(ledger.starts).toEqual([edge, T0])
    setClock(T0 + DAY)
    ledger = store.waits()
    expect(ledger.transitions).toEqual([])
    expect(ledger.spans).toEqual([])
  })
})

describe('filesToDelete', () => {
  const file = (name: string, size: number) => ({ ...(parseHistoryFileName(name) as NonNullable<ReturnType<typeof parseHistoryFileName>>), size })
  const limits = { now: T0, maxBytes: 100, maxAgeMs: 8 * DAY }

  it('deletes the oldest until the total and the incoming bytes fit, never the file written', () => {
    const files = [file('v1-2026-10-20.jsonl', 40), file('v1-2026-10-21.jsonl', 40), file('v1-2026-10-22.jsonl', 30)]
    expect(filesToDelete(files, new Set(['v1-2026-10-22.jsonl']), 10, limits)).toEqual(['v1-2026-10-20.jsonl'])
    expect(filesToDelete(files, new Set(['v1-2026-10-22.jsonl']), 40, limits)).toEqual([
      'v1-2026-10-20.jsonl',
      'v1-2026-10-21.jsonl'
    ])
    expect(filesToDelete(files, new Set(['v1-2026-10-20.jsonl']), 100, limits)).toEqual([
      'v1-2026-10-21.jsonl',
      'v1-2026-10-22.jsonl'
    ])
  })

  it('deletes by age first and orders parts of a day', () => {
    const files = [file('v1-2026-10-05-2.jsonl', 1), file('v1-2026-10-05.jsonl', 1), file('v1-2026-10-22.jsonl', 1)]
    expect(filesToDelete(files, new Set(), 0, limits)).toEqual(['v1-2026-10-05.jsonl', 'v1-2026-10-05-2.jsonl'])
  })

  it('rejects names that are not v1 files or days', () => {
    expect(parseHistoryFileName('v1-2026-02-31.jsonl')).toBeNull()
    expect(parseHistoryFileName('v2-2026-02-01.jsonl')).toBeNull()
    expect(parseHistoryFileName('v1-2026-02-01-1.jsonl')).toBeNull()
  })
})
