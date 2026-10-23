import { createHash } from 'crypto'
import type { ClaudeProfileLimits, LimitWindow } from '@shared/usage/types'
import { parseClaudeOAuthUsage } from '@shared/usage/limits'
import { readClaudeCredentials } from './claudeCredentials'

export type { ClaudeProfileLimits }

export interface ClaudeLimitsClientOptions {
  profiles: () => { configDir: string; label: string; isDefault: boolean }[]
  fetch?: typeof fetch
  readCredentials?: typeof readClaudeCredentials
  now?: () => number
  /** App version for the User-Agent; defaults to `npm_package_version`, else a bare `hydra`. */
  version?: string
}

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REQUEST_TIMEOUT_MS = 15_000
const BACKOFF_STEPS_MS = [60_000, 120_000, 300_000, 600_000]
const KEYCHAIN_DENIED_MS = 24 * 60 * 60 * 1000

interface ProfileState {
  account: string
  configDir: string
  plan: string | null
  status: ClaudeProfileLimits['status']
  windows: LimitWindow[]
  fetchedAt: number | null
  checkedAt: number
  identity: string | null
  failures: number
  backoffUntil: number
  keychainDeniedUntil: number
  /** Hash of the token the API last rejected; it is not sent again until Claude Code writes a new one. */
  rejectedToken: string | null
}

type Profile = { configDir: string; label: string; isDefault: boolean }
type Ready = { profile: Profile; state: ProfileState; token: string }

/**
 * Plan limits of every Claude profile through `/api/oauth/usage`. Read-only: the OAuth token is
 * never refreshed, and it never leaves this class (not in state, errors or logs).
 */
export class ClaudeLimitsClient {
  private readonly listProfiles: ClaudeLimitsClientOptions['profiles']
  private readonly fetchFn: typeof fetch
  private readonly readCredentials: typeof readClaudeCredentials
  private readonly now: () => number
  private readonly userAgent: string
  private readonly states = new Map<string, ProfileState>()
  private visible: string[] = []
  private inflight: Promise<ClaudeProfileLimits[]> | null = null

  constructor(opts: ClaudeLimitsClientOptions) {
    this.listProfiles = opts.profiles
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args))
    this.readCredentials = opts.readCredentials ?? readClaudeCredentials
    this.now = opts.now ?? Date.now
    const version = opts.version ?? process.env.npm_package_version
    this.userAgent = version ? `hydra/${version}` : 'hydra'
  }

  refresh(): Promise<ClaudeProfileLimits[]> {
    if (!this.inflight) {
      this.inflight = this.run()
        .catch(() => this.current())
        .finally(() => {
          this.inflight = null
        })
    }
    return this.inflight
  }

  current(): ClaudeProfileLimits[] {
    return this.visible.flatMap((dir) => {
      const s = this.states.get(dir)
      return s ? [this.snapshot(s)] : []
    })
  }

  nextAllowedAt(): number {
    const now = this.now()
    let earliest = Infinity
    for (const dir of this.visible) {
      const s = this.states.get(dir)
      if (!s) return now
      const until = Math.max(s.backoffUntil, s.status === 'keychain-denied' ? s.keychainDeniedUntil : 0)
      if (until <= now) return now
      earliest = Math.min(earliest, until)
    }
    return earliest === Infinity ? now : earliest
  }

  private snapshot(s: ProfileState): ClaudeProfileLimits {
    return {
      account: s.account,
      configDir: s.configDir,
      plan: s.plan,
      status: s.status,
      windows: s.windows.map((w) => ({ ...w })),
      fetchedAt: s.fetchedAt,
      checkedAt: s.checkedAt
    }
  }

  private stateFor(p: Profile): ProfileState {
    let s = this.states.get(p.configDir)
    if (!s) {
      s = {
        account: p.label,
        configDir: p.configDir,
        plan: null,
        status: 'not-signed-in',
        windows: [],
        fetchedAt: null,
        checkedAt: 0,
        identity: null,
        failures: 0,
        backoffUntil: 0,
        keychainDeniedUntil: 0,
        rejectedToken: null
      }
      this.states.set(p.configDir, s)
    }
    s.account = p.label
    return s
  }

  private async run(): Promise<ClaudeProfileLimits[]> {
    const profiles = this.listProfiles()
    const now = this.now()

    // Phase 1: credentials of every profile that is not backing off.
    const prepared = await Promise.all(profiles.map((p) => this.prepare(p, now)))

    // De-duplicate profiles signed into one account: the default wins, else the first.
    const winners = new Map<string, Profile>()
    for (const p of profiles) {
      const id = this.stateFor(p).identity
      if (!id) continue
      const held = winners.get(id)
      if (!held || (p.isDefault && !held.isDefault)) winners.set(id, p)
    }
    const kept = profiles.filter((p) => {
      const id = this.stateFor(p).identity
      return !id || winners.get(id) === p
    })
    this.visible = kept.map((p) => p.configDir)

    // Phase 2: one request per remaining profile.
    await Promise.all(
      prepared.flatMap((r) => (r && this.visible.includes(r.profile.configDir) ? [this.fetchOne(r)] : []))
    )
    return this.current()
  }

  private async prepare(p: Profile, now: number): Promise<Ready | null> {
    const s = this.stateFor(p)
    if (now < s.backoffUntil) return null
    if (now < s.keychainDeniedUntil) {
      s.status = 'keychain-denied'
      return null
    }
    s.checkedAt = now
    let cred
    try {
      cred = await this.readCredentials(p.configDir, p.isDefault, { now: this.now })
    } catch {
      s.status = 'error'
      return null
    }
    if (!cred.ok) {
      s.status = cred.reason === 'unreadable' ? 'error' : cred.reason
      if (cred.reason === 'keychain-denied') s.keychainDeniedUntil = now + KEYCHAIN_DENIED_MS
      return null
    }
    s.identity = cred.identity
    s.plan = cred.plan
    if (s.rejectedToken === fingerprint(cred.token)) {
      s.status = 'expired'
      return null
    }
    return { profile: p, state: s, token: cred.token }
  }

  private fail(s: ProfileState, status: 'rate-limited' | 'error', retryAfterMs: number): void {
    const step = BACKOFF_STEPS_MS[Math.min(s.failures, BACKOFF_STEPS_MS.length - 1)]
    s.failures += 1
    s.status = status
    s.backoffUntil = this.now() + Math.max(step, retryAfterMs)
  }

  private async fetchOne({ state: s, token }: Ready): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    s.checkedAt = this.now()
    try {
      const res = await this.fetchFn(CLAUDE_USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
          'User-Agent': this.userAgent
        },
        signal: controller.signal
      })
      if (res.status === 401 || res.status === 403) {
        s.status = 'expired'
        s.rejectedToken = fingerprint(token)
        return
      }
      if (res.status === 429 || res.status >= 500 || !res.ok) {
        const retry = Number(res.headers.get('retry-after'))
        const retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0
        this.fail(s, res.status === 429 ? 'rate-limited' : 'error', retryAfterMs)
        return
      }
      const windows = parseClaudeOAuthUsage(await res.json(), s.account)
      s.failures = 0
      s.backoffUntil = 0
      if (windows.length === 0) {
        s.status = 'unavailable'
        return
      }
      s.rejectedToken = null
      s.windows = windows
      s.fetchedAt = this.now()
      s.status = 'ok'
    } catch {
      // Network error, timeout or bad JSON. Nothing from the error is kept: it could echo request data.
      this.fail(s, 'error', 0)
    } finally {
      clearTimeout(timer)
    }
  }
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32)
}
