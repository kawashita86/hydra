import { useMemo } from 'react'
import { PROVIDER_LABELS } from '@shared/types'
import type { OverviewSession, WaitingReason } from '@shared/overview/types'
import { formatDuration, projectName } from './format'
import { EmptyState } from './Card'
import styles from './NeedsYouPanel.module.css'

/** TODO(Step 8): the last wait that ended, from the events history. */
export interface LastWait {
  name: string
  waitedMs: number
  endedAt: number
}

interface NeedsYouPanelProps {
  /** Sessions with status `needs-you`, in any order. */
  sessions: OverviewSession[]
  now: number
  /** True when the snapshot has agents of more than one provider. */
  showProvider: boolean
  onJumpToAgent: (agentId: string) => void
  /** TODO(Step 8): rendered in the empty state when provided. */
  lastWait?: LastWait
}

export function reasonLabel(reason: WaitingReason | undefined): string {
  if (reason === 'permission') return 'Waiting for permission'
  if (reason === 'question') return 'Asked you a question'
  return 'Waiting for you'
}

function Item({
  session,
  now,
  showProvider,
  large,
  onJumpToAgent
}: {
  session: OverviewSession
  now: number
  showProvider: boolean
  large: boolean
  onJumpToAgent: (agentId: string) => void
}) {
  const where = [
    session.worktreeBranch
      ? `${projectName(session.projectDir)} on ${session.worktreeBranch}`
      : projectName(session.projectDir),
    showProvider ? PROVIDER_LABELS[session.provider] : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className={`${styles.item} ${large ? styles.large : ''}`}>
      <div className={styles.main}>
        <div className={styles.head}>
          <span className={styles.name} title={session.name}>
            {session.name}
          </span>
          <span className={styles.reason}>{reasonLabel(session.waitingReason)}</span>
        </div>
        <div className={styles.where} title={session.projectDir}>
          {where}
        </div>
        {session.waitingText && (
          <div className={styles.text} title={session.waitingText}>
            {session.waitingText}
          </div>
        )}
      </div>
      <span className={styles.timer} aria-label="Waiting for">
        {formatDuration(now - session.statusSince)}
      </span>
      <button
        type="button"
        className={styles.jump}
        onClick={() => onJumpToAgent(session.agentId)}
        aria-label={`Jump to ${session.name}`}
      >
        Jump
      </button>
    </li>
  )
}

export function NeedsYouPanel({ sessions, now, showProvider, onJumpToAgent, lastWait }: NeedsYouPanelProps) {
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => a.statusSince - b.statusSince),
    [sessions]
  )

  if (sorted.length === 0) {
    return (
      <>
        <EmptyState>Nothing needs you</EmptyState>
        {lastWait && (
          <p className={styles.lastWait}>
            Last wait: {lastWait.name}, {formatDuration(lastWait.waitedMs)}, ended{' '}
            {formatDuration(now - lastWait.endedAt, { compact: true })} ago
          </p>
        )}
      </>
    )
  }

  return (
    <ul className={styles.list}>
      {sorted.map((s, index) => (
        <Item
          key={s.agentId}
          session={s}
          now={now}
          showProvider={showProvider}
          large={index === 0}
          onJumpToAgent={onJumpToAgent}
        />
      ))}
    </ul>
  )
}
