import { lstatSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { AgentState } from '@shared/types'
import type { ClaudeRegistryStatusFields } from '@shared/overview/types'

// Modelled on agent-lookout (MIT, © 2026 Idris Olubisi): src/collector/adapters/claude-code/registry.ts

/** Registry files are tiny; anything bigger is not one. */
export const MAX_REGISTRY_FILE_BYTES = 64 * 1024
const REGISTRY_FILE = /^\d+\.json$/

/** One live Claude Code process, read from `<configDir>/sessions/<pid>.json`. */
export type RegistryEntry = {
  file: string
  configDir: string
  pid: number
  sessionId?: string
  cwd?: string
  /** Epoch ms. */
  startedAt?: number
  kind?: string
  name?: string
  updatedAt?: number
  statusUpdatedAt?: number
} & ClaudeRegistryStatusFields

export interface FileStat {
  isFile: boolean
  isSymbolicLink: boolean
  size: number
}

export interface ClaudeRegistryReaderOptions {
  /** Names in a directory; throws when missing. */
  readdir?: (dir: string) => string[]
  /** Stat without following symlinks; throws when missing. */
  lstat?: (path: string) => FileStat
  readFile?: (path: string) => string
  /** Whether a process exists. Default: `process.kill(pid, 0)`, EPERM counts as alive. */
  isPidAlive?: (pid: number) => boolean
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Keeps only the known fields; `null` when there is no usable pid. */
function toEntry(raw: unknown, file: string, configDir: string, fileStem: number): RegistryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const pid = num(record.pid) ?? fileStem
  if (!Number.isInteger(pid) || pid <= 0) return null
  return {
    file,
    configDir,
    pid,
    sessionId: str(record.sessionId),
    cwd: str(record.cwd),
    startedAt: num(record.startedAt),
    kind: str(record.kind),
    name: str(record.name),
    updatedAt: num(record.updatedAt),
    statusUpdatedAt: num(record.statusUpdatedAt),
    status: record.status,
    state: record.state,
    waitingFor: record.waitingFor
  }
}

/**
 * Reads Claude Code's per-process registry. The format is undocumented, so every
 * read is defensive and never throws. `.key` files and symlinks are never opened.
 */
export class ClaudeRegistryReader {
  private readonly readdir: (dir: string) => string[]
  private readonly lstat: (path: string) => FileStat
  private readonly readFile: (path: string) => string
  private readonly isPidAlive: (pid: number) => boolean
  /** Last good parse per file, reused once when the next read fails (half-written file). */
  private readonly lastGood = new Map<string, RegistryEntry>()
  private readonly reused = new Set<string>()

  constructor(options: ClaudeRegistryReaderOptions = {}) {
    this.readdir = options.readdir ?? ((dir) => readdirSync(dir))
    this.lstat =
      options.lstat ??
      ((path) => {
        const stat = lstatSync(path)
        return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink(), size: stat.size }
      })
    this.readFile = options.readFile ?? ((path) => readFileSync(path, 'utf-8'))
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  }

  /** Live registry entries across the given Claude config dirs. */
  read(configDirs: string[]): RegistryEntry[] {
    const entries: RegistryEntry[] = []
    const seen = new Set<string>()
    for (const configDir of configDirs) {
      const sessionsDir = join(configDir, 'sessions')
      let names: string[]
      try {
        names = this.readdir(sessionsDir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!REGISTRY_FILE.test(name)) continue
        const file = join(sessionsDir, name)
        seen.add(file)
        const entry = this.readOne(file, configDir, Number.parseInt(name, 10))
        if (entry && this.isPidAlive(entry.pid)) entries.push(entry)
      }
    }
    for (const file of [...this.lastGood.keys()]) {
      if (!seen.has(file)) {
        this.lastGood.delete(file)
        this.reused.delete(file)
      }
    }
    return entries
  }

  private readOne(file: string, configDir: string, fileStem: number): RegistryEntry | null {
    try {
      const stat = this.lstat(file)
      if (stat.isSymbolicLink || !stat.isFile || stat.size > MAX_REGISTRY_FILE_BYTES) {
        this.forget(file)
        return null
      }
      const entry = toEntry(JSON.parse(this.readFile(file)), file, configDir, fileStem)
      if (!entry) return this.fallback(file)
      this.lastGood.set(file, entry)
      this.reused.delete(file)
      return entry
    } catch {
      return this.fallback(file)
    }
  }

  /** Reuses the last good parse once; a second consecutive failure drops the entry. */
  private fallback(file: string): RegistryEntry | null {
    const previous = this.lastGood.get(file)
    if (previous && !this.reused.has(file)) {
      this.reused.add(file)
      return previous
    }
    this.forget(file)
    return null
  }

  private forget(file: string): void {
    this.lastGood.delete(file)
    this.reused.delete(file)
  }
}

/** Agent fields the matcher needs. */
export type MatchableAgent = Pick<AgentState, 'sessionId' | 'pid' | 'projectDir' | 'startedAt'>

/** Tier 3 tolerance between the agent's start and the registry's `startedAt`. */
export const START_MATCH_WINDOW_MS = 10_000

const normalizeDir = (dir: string): string => (dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir)

function startsNear(agent: MatchableAgent, entry: RegistryEntry): boolean {
  if (!agent.startedAt || entry.startedAt === undefined) return false
  const agentStart = Date.parse(agent.startedAt)
  return Number.isFinite(agentStart) && Math.abs(agentStart - entry.startedAt) <= START_MATCH_WINDOW_MS
}

function cwdAndStartCandidates(agent: MatchableAgent, entries: RegistryEntry[]): RegistryEntry[] {
  const dir = normalizeDir(agent.projectDir)
  return entries.filter((e) => e.cwd !== undefined && normalizeDir(e.cwd) === dir && startsNear(agent, e))
}

/**
 * Finds the registry entry of one agent: (1) same `sessionId`, (2) entry pid is the
 * agent's pid or one of its descendants, (3) same cwd and start time, if unambiguous.
 */
export function matchRegistryEntry(
  agent: MatchableAgent,
  entries: RegistryEntry[],
  descendantPids?: Set<number>
): RegistryEntry | null {
  if (agent.sessionId) {
    const bySession = entries.find((e) => e.sessionId === agent.sessionId)
    if (bySession) return bySession
  }
  if (agent.pid !== null) {
    const byPid = entries.find(
      (e) => e.pid === agent.pid || (descendantPids !== undefined && descendantPids.has(e.pid))
    )
    if (byPid) return byPid
  }
  const candidates = cwdAndStartCandidates(agent, entries)
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * Matches every agent, tier by tier across all of them, so an entry is never
 * assigned twice. Tier 3 skips an entry that several agents could claim.
 */
export function matchRegistryEntries(
  agents: Array<MatchableAgent & { id: string }>,
  entries: RegistryEntry[],
  descendantsByAgent: Map<string, Set<number>> = new Map()
): Map<string, RegistryEntry> {
  const result = new Map<string, RegistryEntry>()
  const taken = new Set<RegistryEntry>()
  const assign = (id: string, entry: RegistryEntry): void => {
    result.set(id, entry)
    taken.add(entry)
  }

  for (const agent of agents) {
    if (!agent.sessionId) continue
    const entry = entries.find((e) => !taken.has(e) && e.sessionId === agent.sessionId)
    if (entry) assign(agent.id, entry)
  }

  for (const agent of agents) {
    if (result.has(agent.id) || agent.pid === null) continue
    const descendants = descendantsByAgent.get(agent.id)
    const entry =
      entries.find((e) => !taken.has(e) && e.pid === agent.pid) ??
      entries.find((e) => !taken.has(e) && descendants?.has(e.pid))
    if (entry) assign(agent.id, entry)
  }

  const free = entries.filter((e) => !taken.has(e))
  const candidatesByAgent = new Map<string, RegistryEntry[]>()
  const claims = new Map<RegistryEntry, number>()
  for (const agent of agents) {
    if (result.has(agent.id)) continue
    const candidates = cwdAndStartCandidates(agent, free)
    candidatesByAgent.set(agent.id, candidates)
    for (const entry of candidates) claims.set(entry, (claims.get(entry) ?? 0) + 1)
  }
  for (const [id, candidates] of candidatesByAgent) {
    if (candidates.length === 1 && claims.get(candidates[0]) === 1) assign(id, candidates[0])
  }
  return result
}
