/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ProcessTableReader, descendantPids, parsePsOutput } from './processTree'

describe('descendantPids', () => {
  it('walks children and grandchildren', () => {
    const table = new Map([[2, 1], [3, 2], [4, 3], [5, 1], [6, 99]])
    expect(descendantPids(2, table)).toEqual(new Set([3, 4]))
  })

  it('survives cycles and self-parents', () => {
    const table = new Map([[2, 3], [3, 2], [4, 4], [5, 3]])
    expect(descendantPids(2, table)).toEqual(new Set([3, 5]))
  })

  it('returns empty for an unknown root or missing parents', () => {
    expect(descendantPids(42, new Map([[3, 77]])).size).toBe(0)
  })
})

describe('parsePsOutput', () => {
  it('parses lines and skips junk', () => {
    const table = parsePsOutput('  1     0\n 20  1\nbad line\n')
    expect([...table]).toEqual([[1, 0], [20, 1]])
  })
})

describe('ProcessTableReader', () => {
  it('runs ps at most once per interval', async () => {
    let now = 0
    const runPs = vi.fn().mockResolvedValue('5 1\n')
    const reader = new ProcessTableReader({ runPs, now: () => now, platform: 'linux' })
    expect((await reader.read()).get(5)).toBe(1)
    now = 5000
    await reader.read()
    expect(runPs).toHaveBeenCalledTimes(1)
    now = 10_000
    await reader.read()
    expect(runPs).toHaveBeenCalledTimes(2)
  })

  it('returns empty on failure and on Windows', async () => {
    const failing = new ProcessTableReader({ runPs: () => Promise.reject(new Error('x')), platform: 'linux' })
    expect((await failing.read()).size).toBe(0)
    const runPs = vi.fn().mockResolvedValue('5 1\n')
    const win = new ProcessTableReader({ runPs, platform: 'win32' })
    expect((await win.read()).size).toBe(0)
    expect(runPs).not.toHaveBeenCalled()
  })
})
