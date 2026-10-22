import { PROVIDER_LABELS, PROVIDER_MODELS } from '@shared/types'
import type { OverviewSession, OverviewStatus } from '@shared/overview/types'
import { formatDuration, projectName } from './format'

export const STATUS_LABEL: Record<OverviewStatus, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  starting: 'Starting',
  finished: 'Finished',
  failed: 'Failed'
}

export function statusLabel(session: OverviewSession): string {
  return session.stale ? 'Idle (stale)' : STATUS_LABEL[session.status]
}

/** CSS-module class suffix of a status dot. */
export function dotKey(status: OverviewStatus): string {
  return `dot_${status.replace('-', '_')}`
}

/** `Sonnet`, or `Claude · Sonnet` when the snapshot has more than one provider. */
export function agentLabel(session: OverviewSession, showProvider: boolean): string {
  const model = PROVIDER_MODELS[session.provider]?.find((m) => m.id === session.model)?.label ?? session.model
  return showProvider ? `${PROVIDER_LABELS[session.provider]} · ${model}` : model
}

/** Branch to show: the live one, else Hydra's own worktree branch. */
export function branchOf(session: OverviewSession): string | null {
  return session.branch ?? session.worktreeBranch ?? null
}

/** `quiet for 12m`, or null when the session is not quiet. */
export function quietText(session: OverviewSession, now: number): string | null {
  if (session.quietForMs === undefined) return null
  const quiet = session.lastOutputAt > 0 ? now - session.lastOutputAt : session.quietForMs
  return `quiet for ${formatDuration(Math.max(quiet, session.quietForMs), { compact: true })}`
}

export function folderOf(session: OverviewSession): string {
  return projectName(session.projectDir)
}

/** Repository name for grouping, `null` when unknown. */
export function repoOf(session: OverviewSession): string | null {
  return session.repoName ?? null
}
