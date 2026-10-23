import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeIdentity, claudeKeychainService, readClaudeCredentials } from './claudeCredentials'

const NOW = Date.parse('2026-10-23T09:00:00Z')
const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE'
const noEnv = {} as NodeJS.ProcessEnv

function blob(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: TOKEN,
      expiresAt: NOW + 3_600_000,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      ...over
    }
  })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hydra-cred-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const deps = (extra = {}) => ({ now: () => NOW, env: noEnv, platform: 'linux' as NodeJS.Platform, ...extra })

describe('readClaudeCredentials (file)', () => {
  it('reads a valid file', async () => {
    writeFileSync(join(dir, '.credentials.json'), blob())
    const r = await readClaudeCredentials(dir, true, deps())
    expect(r).toMatchObject({ ok: true, token: TOKEN, expiresAt: NOW + 3_600_000, plan: 'Max 20x' })
    if (r.ok) {
      expect(r.identity).toMatch(/^tok:[0-9a-f]{32}$/)
      expect(r.identity).not.toContain(TOKEN)
    }
  })

  it('plan is a clean value without a tier multiplier', async () => {
    writeFileSync(join(dir, '.credentials.json'), blob({ subscriptionType: 'pro', rateLimitTier: 'default' }))
    const r = await readClaudeCredentials(dir, true, deps())
    expect(r).toMatchObject({ ok: true, plan: 'Pro' })
  })

  it('reports expired', async () => {
    writeFileSync(join(dir, '.credentials.json'), blob({ expiresAt: NOW - 1 }))
    expect(await readClaudeCredentials(dir, true, deps())).toEqual({ ok: false, reason: 'expired' })
  })

  it('reports not-signed-in when the file is missing or has no oauth block', async () => {
    expect(await readClaudeCredentials(dir, true, deps())).toEqual({ ok: false, reason: 'not-signed-in' })
    writeFileSync(join(dir, '.credentials.json'), '{}')
    expect(await readClaudeCredentials(dir, true, deps())).toEqual({ ok: false, reason: 'not-signed-in' })
  })

  it('reports unreadable for malformed JSON, oversized files and links', async () => {
    writeFileSync(join(dir, '.credentials.json'), '{nope')
    expect(await readClaudeCredentials(dir, true, deps())).toEqual({ ok: false, reason: 'unreadable' })
    writeFileSync(join(dir, '.credentials.json'), 'x'.repeat(1024 * 1024 + 1))
    expect(await readClaudeCredentials(dir, true, deps())).toEqual({ ok: false, reason: 'unreadable' })

    const other = mkdtempSync(join(tmpdir(), 'hydra-cred-'))
    try {
      writeFileSync(join(other, 'real.json'), blob())
      mkdirSync(join(other, 'cfg'))
      symlinkSync(join(other, 'real.json'), join(other, 'cfg', '.credentials.json'))
      expect(await readClaudeCredentials(join(other, 'cfg'), true, deps())).toEqual({ ok: false, reason: 'unreadable' })
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('uses the env token for the default profile only', async () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: ' env-token ' } as NodeJS.ProcessEnv
    const r = await readClaudeCredentials(dir, true, deps({ env }))
    expect(r).toMatchObject({ ok: true, token: 'env-token', expiresAt: null, plan: null })
    expect(await readClaudeCredentials(dir, false, deps({ env }))).toEqual({ ok: false, reason: 'not-signed-in' })
  })
})

describe('readClaudeCredentials (macOS Keychain)', () => {
  const mac = (runSecurity: ReturnType<typeof vi.fn>) => deps({ platform: 'darwin' as NodeJS.Platform, runSecurity })

  it('reads the Keychain when there is no file', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: blob() + '\n' })
    const r = await readClaudeCredentials(dir, true, mac(run))
    expect(r).toMatchObject({ ok: true, token: TOKEN })
    expect(run).toHaveBeenCalledWith(['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
  })

  it('prefers the file over the Keychain', async () => {
    writeFileSync(join(dir, '.credentials.json'), blob())
    const run = vi.fn()
    expect(await readClaudeCredentials(dir, true, mac(run))).toMatchObject({ ok: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('uses a hashed service name for a non-default config dir', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 44, stdout: '' })
    const r = await readClaudeCredentials(dir, false, mac(run))
    expect(r).toEqual({ ok: false, reason: 'not-signed-in' })
    const service = run.mock.calls[0][0][2]
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(service).toBe(claudeKeychainService(dir, false))
    expect(claudeKeychainService('/a', false)).not.toBe(claudeKeychainService('/b', false))
  })

  it('maps a denial, other non-zero exits and a spawn failure to keychain-denied', async () => {
    for (const run of [
      vi.fn().mockResolvedValue({ exitCode: 36, stdout: '' }),
      vi.fn().mockResolvedValue({ exitCode: 128, stdout: '' }),
      vi.fn().mockRejectedValue(new Error('timeout'))
    ]) {
      expect(await readClaudeCredentials(dir, true, mac(run))).toEqual({ ok: false, reason: 'keychain-denied' })
    }
  })

  it('reports expired from a Keychain blob and unreadable-free not-signed-in for garbage', async () => {
    const expired = vi.fn().mockResolvedValue({ exitCode: 0, stdout: blob({ expiresAt: NOW - 5 }) })
    expect(await readClaudeCredentials(dir, true, mac(expired))).toEqual({ ok: false, reason: 'expired' })
    const garbage = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'not json' })
    expect(await readClaudeCredentials(dir, true, mac(garbage))).toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('claudeIdentity', () => {
  const jwt = (payload: object): string =>
    `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

  it('is stable across refreshed tokens of one account and hashes the claim', () => {
    const a = claudeIdentity(jwt({ sub: 'user-1', iat: 1 }))
    const b = claudeIdentity(jwt({ sub: 'user-1', iat: 2 }))
    expect(a).toBe(b)
    expect(a).not.toContain('user-1')
    expect(claudeIdentity(jwt({ sub: 'user-2' }))).not.toBe(a)
  })

  it('falls back to a token hash for opaque tokens', () => {
    expect(claudeIdentity('opaque')).toMatch(/^tok:/)
    expect(claudeIdentity('opaque')).toBe(claudeIdentity('opaque'))
    expect(claudeIdentity('opaque')).not.toContain('opaque')
  })
})
