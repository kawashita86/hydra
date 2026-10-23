import { limitAlertLevel, pickChipWindows } from '@shared/usage/limits'
import type { ClaudeProfileLimits, LimitWindow, UsageProvider, UsageState } from '@shared/usage/types'

/** Values older than this render dimmed. */
export const STALE_AFTER_MS = 15 * 60_000

/** A window with the time its value was read. */
export interface TimedWindow {
  window: LimitWindow
  /** Epoch ms of the fetch / log line, `null` when unknown. */
  at: number | null
}

export function isStale(at: number | null, now: number): boolean {
  return at === null || now - at > STALE_AFTER_MS
}

function allTimedWindows(state: UsageState): TimedWindow[] {
  const out: TimedWindow[] = []
  for (const profile of state.claude) {
    for (const window of profile.windows) out.push({ window, at: profile.fetchedAt })
  }
  if (state.codex) {
    for (const window of state.codex.windows) out.push({ window, at: state.codex.at })
  }
  return out
}

export interface ChipWindows {
  session: TimedWindow | null
  weekly: TimedWindow | null
}

/** The most-used session and weekly window over every visible account. */
export function chipWindows(state: UsageState | null): ChipWindows {
  if (!state) return { session: null, weekly: null }
  const timed = allTimedWindows(state)
  const picked = pickChipWindows(timed.map((t) => t.window))
  const find = (w: LimitWindow | null): TimedWindow | null => (w ? (timed.find((t) => t.window === w) ?? null) : null)
  return { session: find(picked.session), weekly: find(picked.weekly) }
}

/** `Claude · alternative` / `Codex`: where a value comes from. */
export function sourceLabel(w: LimitWindow): string {
  return w.provider === 'codex' ? 'Codex' : `Claude ${w.account}`
}

export interface LimitGroup {
  key: string
  provider: UsageProvider
  name: string
  /** `Pro`, `Pro · alternative`, or `''`. */
  subtitle: string
  profile: ClaudeProfileLimits | null
  windows: TimedWindow[]
  /** Epoch ms of the Codex log line, for the source text. */
  codexAt: number | null
}

/** One group per signed-in Claude account (all of them when none is signed in), then Codex. */
export function buildLimitGroups(state: UsageState): LimitGroup[] {
  const signedIn = state.claude.filter((p) => p.status !== 'not-signed-in')
  const shown = signedIn.length > 0 ? signedIn : state.claude
  const groups: LimitGroup[] = shown.map((profile) => {
    const parts = [profile.plan, shown.length > 1 ? profile.account : null].filter((p): p is string => !!p)
    return {
      key: `claude:${profile.account}`,
      provider: 'claude',
      name: 'Claude',
      subtitle: parts.join(' · '),
      profile,
      windows: profile.windows.map((window) => ({ window, at: profile.fetchedAt })),
      codexAt: null
    }
  })
  if (state.codex) {
    groups.push({
      key: 'codex',
      provider: 'codex',
      name: 'Codex',
      subtitle: state.codex.plan ?? '',
      profile: null,
      windows: state.codex.windows.map((window) => ({ window, at: state.codex!.at })),
      codexAt: state.codex.at
    })
  }
  return groups
}

export const LOW_MAX_ROWS = 2

/** The windows at or above their alert level, most used first, at most `LOW_MAX_ROWS`. */
export function lowWindows(groups: LimitGroup[]): Set<LimitWindow> {
  const near = groups
    .flatMap((g) => g.windows.map((t) => t.window))
    .filter((w) => w.usedPercent >= limitAlertLevel(w))
    .sort((a, b) => b.usedPercent - a.usedPercent)
    .slice(0, LOW_MAX_ROWS)
  return new Set(near)
}

/** Newest time any value was read, for the "Updated" text. */
export function newestFetch(state: UsageState): number {
  const times = allTimedWindows(state)
    .map((t) => t.at)
    .filter((t): t is number => t !== null)
  return Math.max(state.updatedAt, ...times)
}
