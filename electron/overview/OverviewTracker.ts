import { EventEmitter } from 'events'
import type { AgentState, AgentStatusPayload } from '@shared/types'
import type {
  AgentActivity,
  OverviewSession,
  OverviewSnapshot,
  OverviewStatus
} from '@shared/overview/types'
import { computeCounts, deriveStatus, isStale, quietForMs } from '@shared/overview/status'
import { matchRegistryEntries, type RegistryEntry } from './claudeRegistry'
import { descendantPids, type ProcessTable } from './processTree'

/** The slice of `AgentManager` the tracker needs. */
export interface OverviewAgentSource {
  list(): AgentState[]
  getActivity(agentId: string): AgentActivity | null
  on(event: 'status', listener: (payload: AgentStatusPayload) => void): unknown
  off(event: 'status', listener: (payload: AgentStatusPayload) => void): unknown
}

export interface OverviewTrackerDeps {
  agentManager: OverviewAgentSource
  registryReader: { read(configDirs: string[]): RegistryEntry[] }
  processTableReader: { read(): Promise<ProcessTable> }
  configDirs: () => string[]
  now?: () => number
  /** Poll interval. Default 2 s. */
  pollIntervalMs?: number
  /** Delay before re-polling after an agent status event. Default 100 ms. */
  statusDebounceMs?: number
}

const NO_ACTIVITY: AgentActivity = { lastOutputAt: 0, lastExitCode: null }

/** Fields whose change is worth a push. Timers and durations are ticked by the renderer. */
function sessionKey(s: OverviewSession): string {
  return JSON.stringify([
    s.agentId,
    s.name,
    s.provider,
    s.model,
    s.projectDir,
    s.worktreeBranch,
    s.status,
    s.statusSince,
    s.waitingReason ?? null,
    s.stale,
    s.quietForMs !== undefined,
    s.pid,
    s.startedAt
  ])
}

/**
 * Polls the agent manager and Claude Code's session registry and builds the
 * Overview snapshot. Emits `'snapshot'` (OverviewSnapshot) when something
 * meaningful changed, never just because time passed.
 */
export class OverviewTracker extends EventEmitter {
  private readonly agentManager: OverviewAgentSource
  private readonly registryReader: OverviewTrackerDeps['registryReader']
  private readonly processTableReader: OverviewTrackerDeps['processTableReader']
  private readonly configDirs: () => string[]
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly statusDebounceMs: number

  private snapshot: OverviewSnapshot | null = null
  private lastKey: string | null = null
  private readonly tracked = new Map<string, { status: OverviewStatus; since: number }>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<OverviewSnapshot> | null = null
  private rerun = false
  private running = false

  private readonly onStatus = (): void => {
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.refresh().catch(() => { /* logged in poll */ })
    }, this.statusDebounceMs)
  }

  constructor(deps: OverviewTrackerDeps) {
    super()
    this.agentManager = deps.agentManager
    this.registryReader = deps.registryReader
    this.processTableReader = deps.processTableReader
    this.configDirs = deps.configDirs
    this.now = deps.now ?? Date.now
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000
    this.statusDebounceMs = deps.statusDebounceMs ?? 100
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.agentManager.on('status', this.onStatus)
    this.pollTimer = setInterval(() => {
      this.refresh().catch(() => { /* logged in poll */ })
    }, this.pollIntervalMs)
    this.refresh().catch(() => { /* logged in poll */ })
  }

  stop(): void {
    this.running = false
    this.agentManager.off('status', this.onStatus)
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.pollTimer = null
    this.debounceTimer = null
  }

  /** The latest snapshot; polls once first when there is none yet. */
  async getSnapshot(): Promise<OverviewSnapshot> {
    return this.snapshot ?? this.refresh()
  }

  /** Polls now. Calls made during a poll share it and trigger one more run afterwards. */
  refresh(): Promise<OverviewSnapshot> {
    if (this.inflight) {
      this.rerun = true
      return this.inflight
    }
    this.inflight = (async () => {
      try {
        let result: OverviewSnapshot
        do {
          this.rerun = false
          result = await this.poll()
        } while (this.rerun)
        return result
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  private async poll(): Promise<OverviewSnapshot> {
    const agents = this.agentManager.list()
    const running = agents.filter((a) => a.status === 'running' && a.provider === 'claude')
    const entries = running.length > 0 ? this.registryReader.read(this.configDirs()) : []

    let matches = matchRegistryEntries(running, entries)
    const unmatched = running.filter((a) => !matches.has(a.id) && a.pid !== null)
    if (unmatched.length > 0 && entries.length > 0) {
      const table = await this.processTableReader.read()
      const descendants = new Map<string, Set<number>>()
      for (const agent of unmatched) descendants.set(agent.id, descendantPids(agent.pid as number, table))
      matches = matchRegistryEntries(running, entries, descendants)
    }

    const now = this.now()
    const alive = new Set<string>()
    const sessions: OverviewSession[] = agents.map((agent) => {
      alive.add(agent.id)
      const activity = this.agentManager.getActivity(agent.id) ?? NO_ACTIVITY
      const derived = deriveStatus(agent, activity, matches.get(agent.id) ?? null, now)
      const previous = this.tracked.get(agent.id)
      const since = previous && previous.status === derived.status ? previous.since : now
      this.tracked.set(agent.id, { status: derived.status, since })
      const started = agent.startedAt ? Date.parse(agent.startedAt) : NaN
      return {
        agentId: agent.id,
        name: agent.name,
        provider: agent.provider,
        model: agent.model,
        projectDir: agent.projectDir,
        worktreeBranch: agent.worktreeBranch ?? null,
        status: derived.status,
        statusSince: since,
        waitingReason: derived.waitingReason,
        quietForMs: quietForMs(derived.status, activity.lastOutputAt, now),
        stale: isStale(derived.status, since, now),
        pid: agent.pid,
        startedAt: Number.isFinite(started) ? started : 0,
        lastOutputAt: activity.lastOutputAt
      }
    })
    for (const id of [...this.tracked.keys()]) {
      if (!alive.has(id)) this.tracked.delete(id)
    }

    const snapshot: OverviewSnapshot = { at: now, sessions, counts: computeCounts(sessions, now) }
    this.snapshot = snapshot
    const key = sessions.map(sessionKey).join('\n')
    if (key !== this.lastKey) {
      this.lastKey = key
      if (this.running) this.emit('snapshot', snapshot)
    }
    return snapshot
  }
}
