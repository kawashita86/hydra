import { EventEmitter } from 'events'
import type { AgentState, AgentStatusPayload } from '@shared/types'
import type {
  AgentActivity,
  AgentDetails,
  OverviewEvent,
  OverviewSession,
  OverviewSnapshot,
  OverviewStatus
} from '@shared/overview/types'
import { diffSnapshots, pointFromSessions, resumedEvent } from '@shared/overview/diff'
import { computeCounts, deriveStatus, isEnded, isStale, quietForMs } from '@shared/overview/status'
import { matchRegistryEntries, type RegistryEntry } from './claudeRegistry'
import type { HistoryStore } from './HistoryStore'
import type { WaitingTextReader } from './waitingText'
import type { AgentDetailsReader, DetailsLocator } from './agentDetails'
import type { GitInfo } from './gitInfo'
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
  /** Reads what a waiting Claude session asks; optional. */
  waitingTextReader?: Pick<WaitingTextReader, 'read' | 'forget' | 'retain'>
  /** Reads repository and branch of a project folder; optional. */
  gitInfo?: { get(projectDir: string): GitInfo | null; retain?(projectDirs: Iterable<string>): void }
  /** Reads the details drawer data on demand; optional. */
  detailsReader?: Pick<AgentDetailsReader, 'read'>
  /** Keeps events and samples; optional. The tracker only feeds it. */
  history?: Pick<HistoryStore, 'addEvents' | 'addPoint' | 'lastPointAt'>
  now?: () => number
  /** Time between history points. Default 5 s. */
  sampleIntervalMs?: number
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
    s.repoName ?? null,
    s.branch ?? null,
    s.commit ?? null,
    s.status,
    s.statusSince,
    s.endedAt ?? null,
    s.exitCode ?? null,
    s.waitingReason ?? null,
    s.waitingText ?? null,
    s.stale,
    s.quietForMs !== undefined,
    s.pid,
    s.startedAt
  ])
}

/**
 * Polls the agent manager and Claude Code's session registry and builds the
 * Overview snapshot. Emits `'snapshot'` (OverviewSnapshot) when something
 * meaningful changed, never just because time passed, and `'events'`
 * (OverviewEvent[]) with the new events of a poll, which it also hands to the
 * history store together with a point every `sampleIntervalMs`.
 */
export class OverviewTracker extends EventEmitter {
  private readonly agentManager: OverviewAgentSource
  private readonly registryReader: OverviewTrackerDeps['registryReader']
  private readonly processTableReader: OverviewTrackerDeps['processTableReader']
  private readonly configDirs: () => string[]
  private readonly waitingTextReader: OverviewTrackerDeps['waitingTextReader']
  private readonly gitInfo: OverviewTrackerDeps['gitInfo']
  private readonly detailsReader: OverviewTrackerDeps['detailsReader']
  private readonly locators = new Map<string, DetailsLocator>()
  private readonly history: OverviewTrackerDeps['history']
  private readonly now: () => number
  private readonly sampleIntervalMs: number
  private lastSampleAt: number | null = null
  private readonly pollIntervalMs: number
  private readonly statusDebounceMs: number

  private snapshot: OverviewSnapshot | null = null
  private lastKey: string | null = null
  /** Claude agents matched to a registry entry in the last poll. */
  private matchedIds = new Set<string>()
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
    this.waitingTextReader = deps.waitingTextReader
    this.gitInfo = deps.gitInfo
    this.detailsReader = deps.detailsReader
    this.history = deps.history
    this.now = deps.now ?? Date.now
    this.sampleIntervalMs = deps.sampleIntervalMs ?? 5000
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

  /** The latest snapshot without polling, `null` before the first poll. */
  peekSnapshot(): OverviewSnapshot | null {
    return this.snapshot
  }

  /** Whether the agent was matched to a Claude registry entry in the last poll. */
  hasRegistryMatch(agentId: string): boolean {
    return this.matchedIds.has(agentId)
  }

  /**
   * Details for the drawer, read from the transcript on demand. `null` when
   * the agent is unknown (it may have disappeared since the last poll).
   */
  getDetails(agentId: string): AgentDetails | null {
    const locator = this.locators.get(agentId)
    if (!locator) return null
    if (!this.detailsReader) return { lastMessage: { unavailable: 'not available' }, tokens: null }
    return this.detailsReader.read(locator)
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

  /** Diffs against the previous poll, feeds the history, and returns the new events. */
  private record(prev: OverviewSession[] | null, sessions: OverviewSession[], now: number): OverviewEvent[] {
    const events = diffSnapshots(prev, sessions, now)
    if (!this.history) return events
    try {
      if (this.lastSampleAt === null || now - this.lastSampleAt >= this.sampleIntervalMs) {
        // A long time since the last point, restored from disk or from this run: watching resumed after a gap.
        const resumed = resumedEvent(this.history.lastPointAt(), now)
        if (resumed) events.unshift(resumed)
        this.lastSampleAt = now
        const agents = Object.fromEntries(
          sessions.map((s) => [s.agentId, { name: s.name, projectDir: s.projectDir }])
        )
        this.history.addEvents(events)
        this.history.addPoint(pointFromSessions(sessions, now), agents)
      } else {
        this.history.addEvents(events)
      }
    } catch (err) {
      console.warn('[overview] cannot record history:', err)
    }
    return events
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

    this.matchedIds = new Set(matches.keys())
    const now = this.now()
    const alive = new Set<string>()
    const waiting = new Set<string>()
    const sessions: OverviewSession[] = agents.map((agent) => {
      alive.add(agent.id)
      const activity = this.agentManager.getActivity(agent.id) ?? NO_ACTIVITY
      const derived = deriveStatus(agent, activity, matches.get(agent.id) ?? null, now)
      const previous = this.tracked.get(agent.id)
      const ended = isEnded(derived.status)
      let endedAt: number | undefined
      if (ended) {
        const fromEnd = agent.endedAt ? Date.parse(agent.endedAt) : NaN
        const fromActivity = Date.parse(agent.lastActivityAt)
        endedAt = Number.isFinite(fromEnd) ? fromEnd : Number.isFinite(fromActivity) ? fromActivity : undefined
      }
      let since = now
      if (previous && previous.status === derived.status) since = previous.since
      else if (endedAt !== undefined) since = Math.min(endedAt, now)
      this.tracked.set(agent.id, { status: derived.status, since })
      const started = agent.startedAt ? Date.parse(agent.startedAt) : NaN
      const match = matches.get(agent.id)
      const sessionId = match?.sessionId ?? agent.sessionId
      let waitingText: string | undefined
      if (this.waitingTextReader && derived.status === 'needs-you' && agent.provider === 'claude' && sessionId) {
        waiting.add(agent.id)
        waitingText =
          this.waitingTextReader.read({
            agentId: agent.id,
            sessionId,
            projectDir: agent.projectDir,
            configDir: match?.configDir
          }) ?? undefined
      }
      this.locators.set(agent.id, {
        provider: agent.provider,
        sessionId: sessionId ?? null,
        projectDir: agent.projectDir,
        configDir: match?.configDir
      })
      const git = this.gitInfo?.get(agent.projectDir) ?? null
      return {
        agentId: agent.id,
        name: agent.name,
        provider: agent.provider,
        model: agent.model,
        projectDir: agent.projectDir,
        worktreeBranch: agent.worktreeBranch ?? null,
        ...(git ? { repoName: git.repoName } : {}),
        ...(git?.branch ? { branch: git.branch } : {}),
        ...(git?.commit ? { commit: git.commit } : {}),
        status: derived.status,
        statusSince: since,
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(activity.lastExitCode !== null ? { exitCode: activity.lastExitCode } : {}),
        waitingReason: derived.waitingReason,
        quietForMs: quietForMs(derived.status, activity.lastOutputAt, now),
        stale: isStale(derived.status, since, now),
        pid: agent.pid,
        startedAt: Number.isFinite(started) ? started : 0,
        lastOutputAt: activity.lastOutputAt,
        ...(waitingText ? { waitingText } : {})
      }
    })
    this.waitingTextReader?.retain(waiting)
    for (const id of [...this.tracked.keys()]) {
      if (!alive.has(id)) this.tracked.delete(id)
    }
    for (const id of [...this.locators.keys()]) {
      if (!alive.has(id)) this.locators.delete(id)
    }
    this.gitInfo?.retain?.(agents.map((a) => a.projectDir))

    const snapshot: OverviewSnapshot = { at: now, sessions, counts: computeCounts(sessions, now) }
    const events = this.record(this.snapshot?.sessions ?? null, sessions, now)
    this.snapshot = snapshot
    if (events.length > 0 && this.running) this.emit('events', events)
    const key = sessions.map(sessionKey).join('\n')
    if (key !== this.lastKey) {
      this.lastKey = key
      if (this.running) this.emit('snapshot', snapshot)
    }
    return snapshot
  }
}
