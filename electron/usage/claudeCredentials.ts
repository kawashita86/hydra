// Adapted from Tokdash (MIT, © JingbiaoMei): src/tokdash/sources/quota/claude.py
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { join } from 'path'
import { nodeHistoryFs } from '../overview/historyFiles'

/**
 * Read-only access to a Claude Code OAuth sign-in. The token is never refreshed, logged, or
 * put in an error: nothing here ever formats a token or a credential file's text into a message.
 * Only `ClaudeLimitsClient` is meant to consume `token`.
 */
export type ClaudeCredentialResult =
  | { ok: true; token: string; expiresAt: number | null; plan: string | null; identity: string }
  | { ok: false; reason: 'not-signed-in' | 'expired' | 'unreadable' | 'keychain-denied' }

export interface SecurityResult {
  exitCode: number
  stdout: string
}

export interface ClaudeCredentialDeps {
  /** Text of a file; rejects with an `ENOENT` error when it is not there. */
  readFile?: (path: string) => Promise<string>
  platform?: NodeJS.Platform
  /** Runs `security <args>`; rejects on spawn failure or timeout. */
  runSecurity?: (args: string[]) => Promise<SecurityResult>
  now?: () => number
  env?: NodeJS.ProcessEnv
}

const MAX_CREDENTIALS_BYTES = 1024 * 1024
const KEYCHAIN_TIMEOUT_MS = 5000
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
/** `security` exit code for "item could not be found". */
const SEC_ITEM_NOT_FOUND = 44
const IDENTITY_CLAIMS = ['account_id', 'accountId', 'sub', 'email']

/** Claude Code keys the Keychain item of a custom config dir by the first 8 hex chars of the SHA-256 of its path. */
export function claudeKeychainService(configDir: string, isDefault: boolean): string {
  if (isDefault) return KEYCHAIN_SERVICE
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `${KEYCHAIN_SERVICE}-${suffix}`
}

async function defaultReadFile(path: string): Promise<string> {
  return nodeHistoryFs.read(path, MAX_CREDENTIALS_BYTES)
}

function defaultRunSecurity(args: string[]): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      args,
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: MAX_CREDENTIALS_BYTES, encoding: 'utf8' },
      (err, stdout) => {
        if (!err) return resolve({ exitCode: 0, stdout })
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
        if (typeof code === 'number') return resolve({ exitCode: code, stdout: '' })
        reject(new Error('security failed')) // never forward err: its message can contain output
      }
    )
  })
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * A non-secret key for the account a token belongs to. Claude Code's access token is a JWT whose
 * payload names the account and survives refreshes; otherwise a hash of the opaque token. Always a
 * hash, so neither the token nor an e-mail address leaves this function.
 */
export function claudeIdentity(token: string): string {
  const parts = token.split('.')
  if (parts.length === 3) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (typeof payload === 'object' && payload !== null) {
        for (const claim of IDENTITY_CLAIMS) {
          const value = (payload as Record<string, unknown>)[claim]
          if (typeof value === 'string' && value) return `id:${sha256(`${claim}:${value}`).slice(0, 32)}`
        }
      }
    } catch {
      // Not a JWT: fall through to the token hash.
    }
  }
  return `tok:${sha256(token).slice(0, 32)}`
}

function planLabel(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  if (typeof subscriptionType !== 'string' || !subscriptionType.trim()) return null
  const base = subscriptionType.trim()
  const name = base[0].toUpperCase() + base.slice(1).toLowerCase()
  const mult = typeof rateLimitTier === 'string' ? /(\d+)x/i.exec(rateLimitTier) : null
  return mult ? `${name} ${mult[1]}x` : name
}

type Parsed = ClaudeCredentialResult | 'none'

function fromBlob(text: string, now: number): Parsed {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'unreadable' }
  const oauth = (data as Record<string, unknown>).claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return 'none'
  const o = oauth as Record<string, unknown>
  const token = typeof o.accessToken === 'string' ? o.accessToken.trim() : ''
  if (!token) return 'none'
  const expiresAt = typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : null
  if (expiresAt !== null && expiresAt <= now) return { ok: false, reason: 'expired' }
  return {
    ok: true,
    token,
    expiresAt,
    plan: planLabel(o.subscriptionType, o.rateLimitTier),
    identity: claudeIdentity(token)
  }
}

export async function readClaudeCredentials(
  configDir: string,
  isDefault: boolean,
  deps: ClaudeCredentialDeps = {}
): Promise<ClaudeCredentialResult> {
  const readFile = deps.readFile ?? defaultReadFile
  const platform = deps.platform ?? process.platform
  const runSecurity = deps.runSecurity ?? defaultRunSecurity
  const now = (deps.now ?? Date.now)()
  const env = deps.env ?? process.env

  if (isDefault) {
    const envToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim()
    if (envToken) {
      return { ok: true, token: envToken, expiresAt: null, plan: null, identity: claudeIdentity(envToken) }
    }
  }

  let fileFailure: ClaudeCredentialResult | null = null
  try {
    const parsed = fromBlob(await readFile(join(configDir, '.credentials.json')), now)
    if (parsed !== 'none') return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') fileFailure = { ok: false, reason: 'unreadable' }
  }
  if (fileFailure && platform !== 'darwin') return fileFailure

  if (platform === 'darwin') {
    let result: SecurityResult
    try {
      result = await runSecurity(['find-generic-password', '-s', claudeKeychainService(configDir, isDefault), '-w'])
    } catch {
      return { ok: false, reason: 'keychain-denied' }
    }
    if (result.exitCode === SEC_ITEM_NOT_FOUND) return fileFailure ?? { ok: false, reason: 'not-signed-in' }
    if (result.exitCode !== 0) return { ok: false, reason: 'keychain-denied' }
    const text = result.stdout.trim()
    if (!text) return fileFailure ?? { ok: false, reason: 'not-signed-in' }
    const parsed = fromBlob(text, now)
    if (parsed !== 'none') return parsed
  }
  return fileFailure ?? { ok: false, reason: 'not-signed-in' }
}
