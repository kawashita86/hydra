import type { CountKey } from '@shared/overview/buckets'
import type { OverviewCounts } from '@shared/overview/types'
import { formatDuration } from './format'
import styles from './CountsRow.module.css'

interface CountsRowProps {
  counts: OverviewCounts
  /** Opens the history chart of a count; Working and Idle become buttons when set. */
  onOpenChart?: (key: CountKey, trigger: HTMLElement) => void
  /** The count whose chart is open. */
  openChart?: CountKey | null
}

function longest(ms: number | null): string {
  return `longest ${ms === null ? '—' : formatDuration(ms, { compact: true })}`
}

export function CountsRow({ counts, onOpenChart, openChart }: CountsRowProps) {
  const label = (text: string, key: CountKey) =>
    onOpenChart ? (
      <button
        type="button"
        className={styles.chartBtn}
        aria-expanded={openChart === key}
        aria-label={`${text} history`}
        onClick={(e) => onOpenChart(key, e.currentTarget)}
      >
        {text}
      </button>
    ) : (
      text
    )
  return (
    <dl className={styles.row} aria-label="Counts">
      <div className={styles.item}>
        <dt className={styles.label}>{label('Working', 'working')}</dt>
        <dd className={styles.value}>{counts.working}</dd>
        <dd className={styles.detail}>{longest(counts.longestWorkingMs)}</dd>
      </div>
      <div className={styles.item}>
        <dt className={styles.label}>{label('Idle', 'idle')}</dt>
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
