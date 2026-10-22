import type { OverviewCounts } from '@shared/overview/types'
import { formatDuration } from './format'
import styles from './CountsRow.module.css'

interface CountsRowProps {
  counts: OverviewCounts
}

function longest(ms: number | null): string {
  return `longest ${ms === null ? '—' : formatDuration(ms, { compact: true })}`
}

export function CountsRow({ counts }: CountsRowProps) {
  return (
    <dl className={styles.row} aria-label="Counts">
      <div className={styles.item}>
        <dt className={styles.label}>Working</dt>
        <dd className={styles.value}>{counts.working}</dd>
        <dd className={styles.detail}>{longest(counts.longestWorkingMs)}</dd>
      </div>
      <div className={styles.item}>
        <dt className={styles.label}>Idle</dt>
        <dd className={styles.value}>{counts.idle}</dd>
        <dd className={styles.detail}>{longest(counts.longestIdleMs)}</dd>
      </div>
      <div className={styles.item}>
        <dt className={styles.label}>Stale</dt>
        <dd className={styles.value}>{counts.stale}</dd>
        <dd className={styles.detail}>idle for 24h+</dd>
      </div>
      <div className={styles.item}>
        <dt className={styles.label}>Agents</dt>
        <dd className={styles.value}>{counts.total}</dd>
        <dd className={styles.detail}>
          {counts.open} open · {counts.finished} finished · {counts.failed} failed
        </dd>
      </div>
    </dl>
  )
}
