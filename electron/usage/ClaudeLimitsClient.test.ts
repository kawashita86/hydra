import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeLimitsClient } from './ClaudeLimitsClient'
import type { ClaudeCredentialResult } from './claudeCredentials'

const body = readFileSync(join(__dirname, '../../shared/usage/fixtures/claude-oauth-usage.json'), 'utf8')
const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE'

const json = (status: number, text = body, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : text, { status, headers })

function setup(opts: { profiles?: { configDir: string; label: string; isDefault: boolean }[]; creds?: Record<string, ClaudeCredentialResult> } = {}) {
  let t = 1_000_000
  const profiles = opts.profiles ?? [{ configDir: '/h/.claude', label: 'default', isDefault: true }]
  const fetchMock = vi.fn()
  const readCredentials = vi.fn(async (dir: string): Promise<ClaudeCredentialResult> =>
    opts.creds?.[dir] ?? { ok: true, token: TOKEN, expiresAt: null, plan: 'Pro', identity: `id-${dir}` }
  )
  const client = new ClaudeLimitsClient({
    profiles: () => profiles,
    fetch: fetchMock as unknown as typeof fetch,
    readCredentials: readCredentials as never,
    now: () => t,
    version: '1.2.3'
  })
  return { client, fetchMock, readCredentials, advance: (ms: number) => (t += ms), now: () => t }
}

const noToken = (v: unknown): void => expect(JSON.stringify(v)).not.toContain(TOKEN)

describe('ClaudeLimitsClient', () => {
  it('fetches, parses and sends the expected request', async () => {
    const { client, fetchMock } = setup()
    fetchMock.mockImplementation(async () => json(200))
    const [p] = await client.refresh()
    expect(p).toMatchObject({ account: 'default', plan: 'Pro', status: 'ok', fetchedAt: 1_000_000 })
    expect(p.windows.map((w) => [w.id, w.usedPercent])).toEqual([['session', 4], ['weekly', 0]])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      'User-Agent': 'hydra/1.2.3'
    })
    noToken(client.current())
    noToken(p)
  })

  it('keeps last-good windows on 401 and reports expired', async () => {
    const { client, fetchMock, advance } = setup()
    fetchMock.mockResolvedValueOnce(json(200)).mockResolvedValueOnce(json(401, '{"error":"x"}'))
    await client.refresh()
    advance(1000)
    const [p] = await client.refresh()
    expect(p.status).toBe('expired')
    expect(p.windows).toHaveLength(2)
    expect(p.fetchedAt).toBe(1_000_000)
    expect(p.checkedAt).toBe(1_001_000)
    noToken(p)
  })

  it('does not resend a rejected token until a new one is written', async () => {
    const { client, fetchMock, readCredentials, advance } = setup()
    fetchMock.mockResolvedValueOnce(json(401, '{}')).mockResolvedValue(json(200))
    await client.refresh()
    advance(60_000)
    const [p] = await client.refresh()
    expect(p.status).toBe('expired')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    readCredentials.mockResolvedValue({ ok: true, token: `${TOKEN}-new`, expiresAt: null, plan: 'Pro', identity: 'id-/h/.claude' })
    advance(60_000)
    const [q] = await client.refresh()
    expect(q.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off 60s, 2m, 5m, 10m on 429 and resets on success', async () => {
    const { client, fetchMock, advance, now } = setup()
    fetchMock.mockImplementation(async () => json(429, '{}'))
    let [p] = await client.refresh()
    expect(p.status).toBe('rate-limited')
    expect(client.nextAllowedAt()).toBe(now() + 60_000)

    advance(30_000)
    await client.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(1) // during back-off: no request

    for (const wait of [60_000, 120_000, 300_000, 600_000, 600_000]) {
      expect(client.nextAllowedAt()).toBeGreaterThan(now())
      advance(client.nextAllowedAt() - now())
      const before = fetchMock.mock.calls.length
      await client.refresh()
      expect(fetchMock.mock.calls.length).toBe(before + 1)
      void wait
    }
    expect(client.nextAllowedAt() - now()).toBe(600_000)

    advance(600_000)
    fetchMock.mockImplementation(async () => json(200))
    ;[p] = await client.refresh()
    expect(p.status).toBe('ok')
    expect(client.nextAllowedAt()).toBe(now())
    fetchMock.mockImplementation(async () => json(500, '{}'))
    await client.refresh()
    expect(client.nextAllowedAt() - now()).toBe(60_000) // ladder restarted
    expect(client.current()[0].status).toBe('error')
  })

  it('lets a larger retry-after win', async () => {
    const { client, fetchMock, now } = setup()
    fetchMock.mockResolvedValue(json(429, '{}', { 'retry-after': '900' }))
    await client.refresh()
    expect(client.nextAllowedAt()).toBe(now() + 900_000)
  })

  it('treats network errors and bad JSON as error with back-off', async () => {
    const { client, fetchMock, now } = setup()
    fetchMock.mockRejectedValueOnce(new Error(`connect failed Bearer ${TOKEN}`))
    let [p] = await client.refresh()
    expect(p.status).toBe('error')
    expect(client.nextAllowedAt()).toBe(now() + 60_000)
    noToken(p)
    const s = setup()
    s.fetchMock.mockResolvedValue(json(200, 'not json'))
    ;[p] = await s.client.refresh()
    expect(p.status).toBe('error')
  })

  it('reports unavailable when the body has no windows', async () => {
    const { client, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, '{}'))
    const [p] = await client.refresh()
    expect(p.status).toBe('unavailable')
    expect(p.windows).toEqual([])
  })

  it('coalesces concurrent refreshes', async () => {
    const { client, fetchMock } = setup()
    fetchMock.mockImplementation(async () => json(200))
    const [a, b] = await Promise.all([client.refresh(), client.refresh()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('requests every profile and drops a duplicate account (default wins)', async () => {
    const profiles = [
      { configDir: '/h/.claude-work', label: 'work', isDefault: false },
      { configDir: '/h/.claude', label: 'default', isDefault: true },
      { configDir: '/h/.claude-other', label: 'other', isDefault: false }
    ]
    const same = { ok: true as const, token: TOKEN, expiresAt: null, plan: 'Pro', identity: 'same' }
    const { client, fetchMock } = setup({
      profiles,
      creds: {
        '/h/.claude-work': same,
        '/h/.claude': same,
        '/h/.claude-other': { ...same, identity: 'different' }
      }
    })
    fetchMock.mockImplementation(async () => json(200))
    const r = await client.refresh()
    expect(r.map((p) => p.account)).toEqual(['default', 'other'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(client.current().map((p) => p.account)).toEqual(['default', 'other'])
  })

  it('reports credential problems without a request', async () => {
    const { client, fetchMock } = setup({ creds: { '/h/.claude': { ok: false, reason: 'not-signed-in' } } })
    const [p] = await client.refresh()
    expect(p.status).toBe('not-signed-in')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not retry a denied Keychain for 24 hours', async () => {
    const { client, readCredentials, advance } = setup({ creds: { '/h/.claude': { ok: false, reason: 'keychain-denied' } } })
    await client.refresh()
    expect(readCredentials).toHaveBeenCalledTimes(1)
    advance(23 * 3600_000)
    expect((await client.refresh())[0].status).toBe('keychain-denied')
    expect(readCredentials).toHaveBeenCalledTimes(1)
    advance(2 * 3600_000)
    await client.refresh()
    expect(readCredentials).toHaveBeenCalledTimes(2)
  })

  it('never exposes the token in any result', async () => {
    const { client, fetchMock, advance } = setup()
    const seen: unknown[] = []
    for (const res of [() => json(200), () => json(401), () => json(429, '{}'), () => json(503, '{}')]) {
      fetchMock.mockImplementation(async () => res())
      seen.push(await client.refresh(), client.current())
      advance(1_000_000)
    }
    noToken(seen)
  })
})
