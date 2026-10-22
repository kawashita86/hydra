import type { ModelId, ProviderId } from '../types'

/** What an agent is doing right now, as shown in the Overview. */
export type OverviewStatus = 'needs-you' | 'working' | 'idle' | 'starting' | 'finished' | 'failed'

/** Why a session waits on the user. */
export type WaitingReason = 'permission' | 'question' | 'other'

/** The status fields of a Claude Code registry entry. Undocumented, so all `unknown`. */
export interface ClaudeRegistryStatusFields {
  /** Live process status: `busy`, `waiting`, `idle` or `shell`. */
  status?: unknown
  /** Background session state: `working`, `blocked`, `done`, `failed` or `stopped`. */
  state?: unknown
  /** Present while waiting, for example `permission prompt`. */
  waitingFor?: unknown
}

/** What the daemon knows about an agent's PTY, beyond `AgentState`. */
export interface AgentActivity {
  /** Epoch ms of the last PTY output. */
  lastOutputAt: number
  /** Exit code of the last run, `null` while running or when unknown. */
  lastExitCode: number | null
}

export interface OverviewSession {
  agentId: string
  name: string
  provider: ProviderId
  model: ModelId
  projectDir: string
  worktreeBranch: string | null
  /** Repository name, read from git files by the daemon (worktrees group under their main repo). */
  repoName?: string
  /** Live branch of `projectDir`; absent when detached or not a repository. */
  branch?: string
  /** Short commit id, set when HEAD is detached. */
  commit?: string
  status: OverviewStatus
  /** Epoch ms when the derived status last changed (kept by the tracker). */
  statusSince: number
  waitingReason?: WaitingReason
  /** What the session asks, one line (Step 6). */
  waitingText?: string
  /** Working with no output for at least `QUIET_AFTER_MS`. */
  quietForMs?: number
  /** Idle for at least `STALE_AFTER_MS`. */
  stale: boolean
  pid: number | null
  /** Epoch ms, `0` when the agent never started. */
  startedAt: number
  lastOutputAt: number
}

export interface OverviewCounts {
  working: number
  /** Idle sessions that are not stale. */
  idle: number
  stale: number
  needsYou: number
  /** Sessions whose process is alive or starting. */
  open: number
  finished: number
  failed: number
  total: number
  /** Longest time in `working`, `null` when none. */
  longestWorkingMs: number | null
  /** Longest time in `idle` among non-stale sessions, `null` when none. */
  longestIdleMs: number | null
}

export interface OverviewSnapshot {
  at: number
  sessions: OverviewSession[]
  counts: OverviewCounts
}

/** A change worth logging (Step 8). */
export interface OverviewEvent {
  at: number
  kind: 'appeared' | 'status' | 'ended' | 'stopped-by-user'
  agentId: string
  name: string
  from?: OverviewStatus
  to?: OverviewStatus
  /** Set when leaving `needs-you`: how long the user was waited on. */
  waitedMs?: number
}

/** One 5 s sample of the counts per status (Step 8). */
export interface HistoryPoint {
  at: number
  needsYou: number
  working: number
  idle: number
  total: number
}

/** Time agents waited on the user (Step 11). */
export interface WaitTotals {
  todayMs: number
  weekMs: number
  /** One entry per local day, oldest first. `measured` is false when nothing was watched. */
  byDay: { day: string; ms: number; measured: boolean }[]
  /** Longest waiters first. */
  longest: { agentId: string; name: string; ms: number }[]
}

/** What the details drawer shows, read on demand from the transcript. */
export interface AgentDetails {
  lastMessage: { text: string; truncated: boolean } | { unavailable: string }
  /** Token counts of the newest reply; `cached` is the part of `input` read from a cache. */
  tokens: { input: number; cached?: number; output: number } | null
}
