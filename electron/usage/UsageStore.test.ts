import { describe, expect, it, vi } from 'vitest'
import { PRICING_VERSION } from '@shared/usage/pricing'
import { totalTokens } from '@shared/usage/types'
import { BUCKET_MAX_AGE_MS, QUIET_MS, UsageStore, type UsageScanProgress, type UsageSource, type UsageStoreOptions } from './UsageStore'
import type { UsageFileInfo, UsageFs } from './usageFiles'

const T0 = Date.parse('2026-10-22T12:00:00.000Z')
const DIR = '/cache'
const CLAUDE = '/c/projects'
const CODEX = '/x/sessions'
const SOURCES: UsageSource[] = [
  { provider: 'claude', root: CLAUDE, maxDepth: 4 },
  { provider: 'codex', root: CODEX, maxDepth: 5 }
]

class MemoryFs implements UsageFs {
  files = new Map<string, { data: Buffer; mtimeMs: number; ino: number }>()
  texts = new Map<string, string>()
  private nextIno = 1
  write(path: string, text: string, mtimeMs = T0 - 3600_000, ino?: number): void {
    const old = this.files.get(path)
    this.files.set(path, { data: Buffer.from(text, 'utf8'), mtimeMs, ino: ino ?? old?.ino ?? this.nextIno++ })
  }
  append(path: string, text: string, mtimeMs = T0 - 3600_000): void {
    const old = this.files.get(path)!
    this.files.set(path, { ...old, data: Buffer.concat([old.data, Buffer.from(text, 'utf8')]), mtimeMs })
  }
  replace(path: string, text: string): void {
    this.write(path, text, T0 - 1800_000, this.nextIno++)
  }
  remove(path: string): void {
    this.files.delete(path)
  }
  walk(root: string): UsageFileInfo[] {
    return [...this.files]
      .filter(([p]) => p.startsWith(`${root}/`))
      .map(([path, f]) => ({ path, size: f.data.length, mtimeMs: f.mtimeMs, ino: f.ino }))
  }
  readChunk(path: string, offset: number, maxBytes: number): Buffer {
    const f = this.files.get(path)
    if (!f) throw new Error('gone')
    return f.data.subarray(offset, offset + maxBytes)
  }
  readText(path: string): string | null {
    return this.texts.get(path) ?? null
  }
  writeAtomic(path: string, text: string): void {
    this.texts.set(path, text)
  }
  makeFolder(): void {}
}

function claude(id: string, iso: string, tokens: { input?: number; output?: number } = {}, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'assistant',
      requestId: `req_${id}`,
      timestamp: iso,
      cwd: '/home/u/proj',
      message: {
        id: `msg_${id}`,
        model: 'claude-opus-5',
        usage: { input_tokens: tokens.input ?? 10, output_tokens: tokens.output ?? 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      },
      ...extra
    }) + '\n'
  )
}

const cRow = (iso: string, type: string, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: iso, type, payload }) + '\n'
const U = (input: number, output: number): Record<string, number> => ({
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output
})
const codexCount = (iso: string, last: Record<string, number>, total: Record<string, number>, extra: Record<string, unknown> = {}): string =>
  cRow(iso, 'event_msg', { type: 'token_count', info: { last_token_usage: last, total_token_usage: total }, ...extra })
const codexHead = (id: string): string =>
  cRow('2026-10-22T09:00:00.000Z', 'session_meta', { id, cwd: '/w/proj' }) +
  cRow('2026-10-22T09:00:01.000Z', 'turn_context', { turn_id: 't1', model: 'gpt-5-codex' })

function make(fs: MemoryFs, extra: Partial<UsageStoreOptions> = {}, now = T0): UsageStore {
  return new UsageStore({ dir: DIR, sources: () => SOURCES, fs, now: () => now, yieldToLoop: async () => {}, ...extra })
}

const total = (s: UsageStore): number => s.buckets().reduce((n, b) => n + totalTokens(b.tokens), 0)
const messages = (s: UsageStore): number => s.buckets().reduce((n, b) => n + b.messages, 0)

describe('scan', () => {
  it('reads Claude and Codex files, with hour buckets and costs', async () => {
    const fs = new MemoryFs()
    fs.write(`${CLAUDE}/p/s1.jsonl`, claude('1', '2026-10-22T10:15:00.000Z') + claude('2', '2026-10-22T10:45:00.000Z') + claude('3', '2026-10-22T11:05:00.000Z'))
    fs.write(`${CODEX}/2026/10/22/rollout-a.jsonl`, codexHead('s1') + codexCount('2026-10-22T09:10:00.000Z', U(100, 20), U(100, 20)))
    const store = make(fs)
    expect(await store.scan()).toBe(true)
    const b = store.buckets()
    expect(b).toHaveLength(3)
    const ten = b.find((x) => x.provider === 'claude' && x.hour === Date.parse('2026-10-22T10:00:00Z'))!
    expect(ten).toMatchObject({ messages: 2, projectKey: '/home/u/proj', unpricedMessages: 0 })
    expect(ten.tokens.input).toBe(20)
    expect(ten.costUsd).toBeGreaterThan(0)
    expect(b.find((x) => x.provider === 'codex')!.tokens).toMatchObject({ input: 100, output: 20 })
    expect(store.status()).toMatchObject({ indexing: false, files: 2, lastScanAt: T0 })
    expect(store.summary('today', new Date(T0)).totalTokens).toBe(total(store))
    expect(await store.scan()).toBe(false)
  })

  it('counts only appended lines on the next scan', async () => {
    const fs = new MemoryFs()
    const path = `${CLAUDE}/p/s1.jsonl`
    fs.write(path, claude('1', '2026-10-22T10:00:00.000Z'))
    const store = make(fs)
    await store.scan()
    expect(messages(store)).toBe(1)
    const readChunk = vi.spyOn(fs, 'readChunk')
    await store.scan() // unchanged: not read
    expect(readChunk).not.toHaveBeenCalled()
    fs.append(path, claude('2', '2026-10-22T10:30:00.000Z'), T0 - 1000)
    expect(await store.scan()).toBe(true)
    expect(messages(store)).toBe(2)
    expect(total(store)).toBe(30)
  })

  it('leaves a partial last line for the next scan', async () => {
    const fs = new MemoryFs()
    const path = `${CLAUDE}/p/s1.jsonl`
    const second = claude('2', '2026-10-22T10:30:00.000Z')
    fs.write(path, claude('1', '2026-10-22T10:00:00.000Z') + second.slice(0, 40))
    const store = make(fs)
    await store.scan()
    expect(messages(store)).toBe(1)
    fs.append(path, second.slice(40), T0 - 1000)
    await store.scan()
    expect(messages(store)).toBe(2)
  })

  it('keeps byte offsets right when a multi-byte character straddles a chunk boundary', async () => {
    const fs = new MemoryFs()
    const path = `${CLAUDE}/p/s1.jsonl`
    const lines = [1, 2, 3, 4].map((i) => claude(String(i), '2026-10-22T10:00:00.000Z', {}, { note: 'héllo wörld ✓ 日本語 😀'.repeat(3) }))
    fs.write(path, lines.join(''))
    for (const chunkBytes of [521, 600, 677, 801, 1003, 1500]) {
      const store = make(fs, { chunkBytes })
      await store.scan()
      expect(messages(store)).toBe(4)
      fs.append(path, claude('5', '2026-10-22T11:00:00.000Z', {}, { note: '日本語' }), T0 - 1000)
      await store.scan()
      expect(messages(store)).toBe(5)
      fs.write(path, lines.join('')) // back to the start for the next size
    }
  })

  it('counts a Claude key shared by two files once', async () => {
    const fs = new MemoryFs()
    const a = claude('1', '2026-10-22T10:00:00.000Z') + claude('2', '2026-10-22T10:10:00.000Z')
    fs.write(`${CLAUDE}/p/a.jsonl`, a)
    fs.write(`${CLAUDE}/p/b.jsonl`, a + claude('3', '2026-10-22T10:20:00.000Z') + claude('3', '2026-10-22T10:20:00.000Z'))
    const store = make(fs)
    await store.scan()
    expect(messages(store)).toBe(3)
  })

  it('re-reads a replaced file without double counting or being blocked by its old keys', async () => {
    const fs = new MemoryFs()
    const path = `${CLAUDE}/p/a.jsonl`
    fs.write(path, claude('1', '2026-10-22T10:00:00.000Z') + claude('2', '2026-10-22T10:10:00.000Z') + claude('3', '2026-10-22T10:20:00.000Z'))
    const store = make(fs)
    await store.scan()
    expect(messages(store)).toBe(3)
    fs.replace(path, claude('1', '2026-10-22T10:00:00.000Z', { input: 100 })) // shorter, same first key
    expect(await store.scan()).toBe(true)
    expect(messages(store)).toBe(1)
    expect(store.buckets()[0].tokens.input).toBe(100)
  })

  it('keeps the totals of a file that disappeared', async () => {
    const fs = new MemoryFs()
    const path = `${CLAUDE}/p/a.jsonl`
    fs.write(path, claude('1', '2026-10-22T10:00:00.000Z') + claude('2', '2026-10-22T10:10:00.000Z'))
    const store = make(fs)
    await store.scan()
    fs.remove(path)
    await store.scan()
    expect(messages(store)).toBe(2)
    expect(store.status().files).toBe(0)
    store.stop()
    const again = make(fs)
    again.load()
    expect(messages(again)).toBe(2)
  })
})

describe('codex', () => {
  it('returns the newest limits across files', async () => {
    const fs = new MemoryFs()
    const rl = (used: number): Record<string, unknown> => ({ rate_limits: { plan_type: 'plus', primary: { used_percent: used, window_minutes: 300, resets_at: 2e9 } } })
    fs.write(`${CODEX}/2026/10/22/a.jsonl`, codexHead('a') + codexCount('2026-10-22T09:30:00.000Z', U(1, 1), U(1, 1), rl(10)))
    fs.write(`${CODEX}/2026/10/22/b.jsonl`, codexHead('b') + codexCount('2026-10-22T10:30:00.000Z', U(1, 1), U(1, 1), rl(40)))
    fs.write(`${CODEX}/2026/10/22/c.jsonl`, codexHead('c') + codexCount('2026-10-22T08:30:00.000Z', U(1, 1), U(1, 1), rl(70)))
    const store = make(fs)
    expect(store.codexLimits()).toBeNull()
    await store.scan()
    expect(store.codexLimits()!.windows[0].usedPercent).toBe(40)
    expect(store.codexLimits()!.at).toBe(Date.parse('2026-10-22T10:30:00.000Z'))
  })

  it('flushes a compaction only once the file is quiet', async () => {
    const fs = new MemoryFs()
    const path = `${CODEX}/2026/10/22/a.jsonl`
    const before = U(1000, 50)
    const compaction = U(5000, 700)
    const thread = U(6000, 750)
    const record = { response_id: 'resp-c', turn_id: 'turn-1', usage: compaction, thread_token_usage: thread }
    const text =
      cRow('2026-10-22T09:00:00.000Z', 'session_meta', { id: 's1', cwd: '/w' }) +
      cRow('2026-10-22T09:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5-codex' }) +
      codexCount('2026-10-22T09:00:02.000Z', before, before) +
      cRow('2026-10-22T09:00:03.000Z', 'token_usage_record', record) +
      cRow('2026-10-22T09:00:03.000Z', 'compacted', { compaction_response_id: 'resp-c', latest_token_usage_record: record }) +
      cRow('2026-10-22T09:00:04.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5-codex' })
    fs.write(path, text, T0 - 60_000) // written a minute ago
    let now = T0
    const store = new UsageStore({ dir: DIR, sources: () => SOURCES, fs, now: () => now, yieldToLoop: async () => {} })
    await store.scan()
    expect(messages(store)).toBe(1)
    now = T0 + 5 * 60_000 // still not quiet (file untouched for 6 min)
    await store.scan()
    expect(messages(store)).toBe(1)
    now = T0 + QUIET_MS // untouched for 11 minutes, file itself unchanged
    expect(await store.scan()).toBe(true)
    expect(messages(store)).toBe(2)
    now += 60 * 60_000
    await store.scan()
    expect(messages(store)).toBe(2)
  })
})

describe('persistence', () => {
  async function filled(): Promise<{ fs: MemoryFs; store: UsageStore }> {
    const fs = new MemoryFs()
    fs.write(`${CLAUDE}/p/a.jsonl`, claude('1', '2026-10-22T10:00:00.000Z') + claude('2', '2026-10-21T10:10:00.000Z'))
    fs.write(`${CODEX}/2026/10/22/a.jsonl`, codexHead('s') + codexCount('2026-10-22T09:10:00.000Z', U(100, 20), U(100, 20), { rate_limits: { primary: { used_percent: 9, window_minutes: 300, resets_at: 2e9 } } }))
    const store = make(fs)
    await store.scan()
    return { fs, store }
  }

  it('restores identical buckets, limits, and does not re-read or recount', async () => {
    const { fs, store } = await filled()
    store.stop()
    expect(fs.texts.has(`${DIR}/v1.json`)).toBe(true)
    const next = make(fs)
    next.load()
    expect(next.buckets()).toEqual(store.buckets())
    expect(next.codexLimits()).toEqual(store.codexLimits())
    const readChunk = vi.spyOn(fs, 'readChunk')
    expect(await next.scan()).toBe(false)
    expect(readChunk).not.toHaveBeenCalled()
    fs.append(`${CLAUDE}/p/a.jsonl`, claude('1', '2026-10-22T10:00:00.000Z') + claude('9', '2026-10-22T12:00:00.000Z'), T0 - 10)
    await next.scan()
    expect(messages(next)).toBe(4) // msg_1 was remembered as seen; only msg_9 is new
  })

  it('starts empty on a pricing version mismatch, a bad file or a wrong version', async () => {
    const { fs, store } = await filled()
    store.stop()
    const good = fs.texts.get(`${DIR}/v1.json`)!
    for (const bad of [
      good.replace(`"pricingVersion":${PRICING_VERSION}`, `"pricingVersion":${PRICING_VERSION + 1}`),
      good.replace('"version":1', '"version":2'),
      good.slice(0, 50),
      'null'
    ]) {
      fs.texts.set(`${DIR}/v1.json`, bad)
      const next = make(fs)
      next.load()
      expect(next.buckets()).toEqual([])
      expect(next.status().files).toBe(0)
      await next.scan()
      expect(next.buckets()).toEqual(store.buckets()) // a full rescan gives the same totals
    }
  })

  it('writes at most once per 30 seconds while scanning, and on flush', async () => {
    const fs = new MemoryFs()
    const path = `${CLAUDE}/p/a.jsonl`
    fs.write(path, claude('1', '2026-10-22T10:00:00.000Z'))
    const write = vi.spyOn(fs, 'writeAtomic')
    let now = T0
    const store = new UsageStore({ dir: DIR, sources: () => SOURCES, fs, now: () => now, yieldToLoop: async () => {} })
    await store.scan()
    expect(write).toHaveBeenCalledTimes(1)
    now += 10_000
    fs.append(path, claude('2', '2026-10-22T10:05:00.000Z'), now)
    await store.scan()
    expect(write).toHaveBeenCalledTimes(1)
    now += 25_000
    fs.append(path, claude('3', '2026-10-22T10:06:00.000Z'), now)
    await store.scan()
    expect(write).toHaveBeenCalledTimes(2)
    now += 1000
    fs.append(path, claude('4', '2026-10-22T10:07:00.000Z'), now)
    await store.scan()
    store.flush()
    expect(write).toHaveBeenCalledTimes(3)
    store.flush()
    expect(write).toHaveBeenCalledTimes(3)
  })

  it('never stores message text', async () => {
    const fs = new MemoryFs()
    fs.write(`${CLAUDE}/p/a.jsonl`, claude('1', '2026-10-22T10:00:00.000Z', {}, { secret: 'SECRET-TEXT' }))
    const store = make(fs)
    await store.scan()
    store.stop()
    expect(fs.texts.get(`${DIR}/v1.json`)).not.toContain('SECRET-TEXT')
  })
})

describe('scan control', () => {
  it('joins concurrent scans', async () => {
    const fs = new MemoryFs()
    fs.write(`${CLAUDE}/p/a.jsonl`, claude('1', '2026-10-22T10:00:00.000Z'))
    const store = make(fs)
    const walk = vi.spyOn(fs, 'walk')
    const first = store.scan()
    expect(store.status().indexing).toBe(true)
    const second = store.scan()
    expect(second).toBe(first)
    expect(await first).toBe(true)
    expect(walk).toHaveBeenCalledTimes(2) // two sources, one pass
    expect(store.status().indexing).toBe(false)
  })

  it('reports progress with totals', async () => {
    const fs = new MemoryFs()
    const a = claude('1', '2026-10-22T10:00:00.000Z') + claude('2', '2026-10-22T10:01:00.000Z')
    const b = claude('3', '2026-10-22T10:02:00.000Z')
    fs.write(`${CLAUDE}/p/a.jsonl`, a)
    fs.write(`${CLAUDE}/p/b.jsonl`, b)
    const seen: UsageScanProgress[] = []
    const store = make(fs)
    await store.scan((p) => seen.push(p))
    const last = seen[seen.length - 1]
    expect(seen[0]).toMatchObject({ filesDone: 0, filesTotal: 2, bytesDone: 0, bytesTotal: a.length + b.length })
    expect(last).toEqual({ filesDone: 2, filesTotal: 2, bytesDone: a.length + b.length, bytesTotal: a.length + b.length })
    expect(store.status().progress).toBeNull()
  })

  it('prunes buckets older than 400 days', async () => {
    const fs = new MemoryFs()
    const old = new Date(T0 - BUCKET_MAX_AGE_MS - 3 * 3600_000).toISOString()
    const recent = new Date(T0 - 2 * 3600_000).toISOString()
    fs.write(`${CLAUDE}/p/a.jsonl`, claude('1', old) + claude('2', recent))
    const store = make(fs)
    await store.scan()
    expect(store.buckets()).toHaveLength(1)
    expect(store.buckets()[0].hour).toBe(Math.floor(Date.parse(recent) / 3600_000) * 3600_000)
  })
})
