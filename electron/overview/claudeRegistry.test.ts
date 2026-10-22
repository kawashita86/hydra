/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ClaudeRegistryReader,
  matchRegistryEntries,
  matchRegistryEntry,
  type RegistryEntry
} from './claudeRegistry'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hydra-registry-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function profile(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  return dir
}
const put = (dir: string, file: string, body: unknown): string => {
  const path = join(dir, 'sessions', file)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid)

describe('ClaudeRegistryReader', () => {
  it('reads a good file and keeps only known fields', () => {
    const dir = profile('a')
    put(dir, '100.json', {
      pid: 100, sessionId: 's1', cwd: '/p', startedAt: 5, kind: 'interactive', name: 'n',
      status: 'busy', waitingFor: 'permission prompt', messagingSocketPath: '/secret', bogus: 1
    })
    const [entry] = new ClaudeRegistryReader({ isPidAlive: alive(100) }).read([dir])
    expect(entry).toMatchObject({ pid: 100, sessionId: 's1', cwd: '/p', status: 'busy', configDir: dir })
    expect(entry).not.toHaveProperty('messagingSocketPath')
    expect(entry).not.toHaveProperty('bogus')
  })

  it('skips malformed files, .key files, non-numeric names and oversize files', () => {
    const dir = profile('a')
    put(dir, '1.json', '{not json')
    put(dir, '2.abc.key', { pid: 2 })
    put(dir, 'x.json', { pid: 3 })
    put(dir, '4.json', { pid: 4, pad: 'x'.repeat(70 * 1024) })
    expect(new ClaudeRegistryReader({ isPidAlive: () => true }).read([dir])).toEqual([])
  })

  it('reuses the last good parse once for a half-written file, then recovers', () => {
    const dir = profile('a')
    const path = put(dir, '100.json', { pid: 100, sessionId: 's1' })
    const reader = new ClaudeRegistryReader({ isPidAlive: alive(100) })
    expect(reader.read([dir])).toHaveLength(1)
    writeFileSync(path, '{"pid": 10')
    expect(reader.read([dir])[0].sessionId).toBe('s1')
    expect(reader.read([dir])).toEqual([])
    writeFileSync(path, JSON.stringify({ pid: 100, sessionId: 's2' }))
    expect(reader.read([dir])[0].sessionId).toBe('s2')
  })

  it('ignores symlinks', () => {
    const dir = profile('a')
    const target = join(root, 'target.json')
    writeFileSync(target, JSON.stringify({ pid: 100 }))
    symlinkSync(target, join(dir, 'sessions', '100.json'))
    expect(new ClaudeRegistryReader({ isPidAlive: () => true }).read([dir])).toEqual([])
  })

  it('drops dead pids', () => {
    const dir = profile('a')
    put(dir, '100.json', { pid: 100 })
    put(dir, '101.json', { pid: 101 })
    const pids = new ClaudeRegistryReader({ isPidAlive: alive(101) }).read([dir]).map((e) => e.pid)
    expect(pids).toEqual([101])
  })

  it('treats the real process as alive and a bogus pid as dead by default', () => {
    const dir = profile('a')
    put(dir, `${process.pid}.json`, { pid: process.pid })
    put(dir, '2147483646.json', { pid: 2147483646 })
    expect(new ClaudeRegistryReader().read([dir]).map((e) => e.pid)).toEqual([process.pid])
  })

  it('merges two profile dirs and tolerates a missing one', () => {
    const a = profile('a')
    const b = profile('b')
    put(a, '100.json', { pid: 100 })
    put(b, '200.json', { pid: 200 })
    const entries = new ClaudeRegistryReader({ isPidAlive: () => true }).read([a, b, join(root, 'nope')])
    expect(entries.map((e) => [e.pid, e.configDir])).toEqual([[100, a], [200, b]])
  })
})

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  file: 'f', configDir: 'c', pid: 1, ...over
})
const T0 = Date.parse('2026-10-22T10:00:00Z')
const agent = (over: Partial<{ id: string; sessionId: string | null; pid: number | null; projectDir: string; startedAt: string | null }> = {}) => ({
  id: 'a1', sessionId: null, pid: null, projectDir: '/p', startedAt: new Date(T0).toISOString(), ...over
})

describe('matchRegistryEntry', () => {
  it('prefers sessionId over pid', () => {
    const bySession = entry({ pid: 9, sessionId: 's' })
    const byPid = entry({ pid: 5 })
    expect(matchRegistryEntry(agent({ sessionId: 's', pid: 5 }), [byPid, bySession])).toBe(bySession)
  })

  it('matches by pid or descendant pid', () => {
    const e = entry({ pid: 77 })
    expect(matchRegistryEntry(agent({ pid: 77 }), [e])).toBe(e)
    expect(matchRegistryEntry(agent({ pid: 70 }), [e])).toBeNull()
    expect(matchRegistryEntry(agent({ pid: 70 }), [e], new Set([77]))).toBe(e)
  })

  it('matches by cwd and start time only when unambiguous', () => {
    const near = entry({ pid: 1, cwd: '/p/', startedAt: T0 + 3000 })
    const far = entry({ pid: 2, cwd: '/p', startedAt: T0 + 60_000 })
    expect(matchRegistryEntry(agent(), [near, far])).toBe(near)
    expect(matchRegistryEntry(agent(), [near, entry({ pid: 3, cwd: '/p', startedAt: T0 })])).toBeNull()
    expect(matchRegistryEntry(agent({ startedAt: null }), [near])).toBeNull()
  })
})

describe('matchRegistryEntries', () => {
  it('never assigns one entry to two agents', () => {
    const e = entry({ pid: 5, sessionId: 's' })
    const result = matchRegistryEntries([agent({ id: 'a', sessionId: 's' }), agent({ id: 'b', pid: 5 })], [e])
    expect([...result.keys()]).toEqual(['a'])
  })

  it('resolves tiers in order across agents', () => {
    const e1 = entry({ pid: 5, sessionId: 's2' })
    const e2 = entry({ pid: 6, sessionId: 's1' })
    const result = matchRegistryEntries(
      [agent({ id: 'a', sessionId: 's1', pid: 5 }), agent({ id: 'b', pid: 5 })],
      [e1, e2]
    )
    expect(result.get('a')).toBe(e2)
    expect(result.get('b')).toBe(e1)
  })

  it('uses descendants and skips an entry two agents could claim by cwd', () => {
    const child = entry({ pid: 90 })
    const shared = entry({ pid: 91, cwd: '/p', startedAt: T0 })
    const result = matchRegistryEntries(
      [agent({ id: 'a', pid: 80 }), agent({ id: 'b' }), agent({ id: 'c' })],
      [child, shared],
      new Map([['a', new Set([90])]])
    )
    expect(result.get('a')).toBe(child)
    expect(result.has('b')).toBe(false)
    expect(result.has('c')).toBe(false)
  })
})
