import { useMemo, useState } from 'react'
import { computeCounts } from '@shared/overview/status'
import type { OverviewSession, OverviewStatus } from '@shared/overview/types'
import { useOverview } from '@/hooks/useOverview'
import { Card, EmptyState } from './Card'
import styles from './OverviewView.module.css'

const FILTER_STORAGE_KEY = 'hydra.overview.projectFilter'
const ALL_PROJECTS = ''

interface OverviewViewProps {
  onOpenNewAgent?: () => void
}

function readStoredFilter(): string {
  try {
    return localStorage.getItem(FILTER_STORAGE_KEY) ?? ALL_PROJECTS
  } catch {
    return ALL_PROJECTS
  }
}

function writeStoredFilter(value: string): void {
  try {
    if (value === ALL_PROJECTS) localStorage.removeItem(FILTER_STORAGE_KEY)
    else localStorage.setItem(FILTER_STORAGE_KEY, value)
  } catch {
    /* storage unavailable */
  }
}

export function projectName(projectDir: string): string {
  const parts = projectDir.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? projectDir
}

const STATUS_LABEL: Record<OverviewStatus, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  starting: 'Starting',
  finished: 'Finished',
  failed: 'Failed'
}

function statusLabel(session: OverviewSession): string {
  return session.stale ? 'Idle (stale)' : STATUS_LABEL[session.status]
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function OverviewView({ onOpenNewAgent }: OverviewViewProps) {
  const { snapshot, loading, error, now } = useOverview()
  const [storedFilter, setStoredFilter] = useState<string>(readStoredFilter)

  const allSessions = useMemo(() => snapshot?.sessions ?? [], [snapshot])

  const projectDirs = useMemo(
    () => Array.from(new Set(allSessions.map((s) => s.projectDir))).sort((a, b) =>
      projectName(a).localeCompare(projectName(b))
    ),
    [allSessions]
  )

  // A stored project that no longer has agents falls back to "All" without forgetting the choice.
  const filter = projectDirs.includes(storedFilter) ? storedFilter : ALL_PROJECTS

  const sessions = useMemo(
    () => (filter === ALL_PROJECTS ? allSessions : allSessions.filter((s) => s.projectDir === filter)),
    [allSessions, filter]
  )
  const counts = useMemo(() => computeCounts(sessions, now), [sessions, now])

  const handleFilterChange = (value: string) => {
    setStoredFilter(value)
    writeStoredFilter(value)
  }

  if (loading && !snapshot) {
    return (
      <div className={styles.overview}>
        <div className={styles.centered}>Loading overview…</div>
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className={styles.overview}>
        <div className={styles.centered} role="alert">
          <p className={styles.errorTitle}>The overview is not available</p>
          <p className={styles.errorText}>
            {error ?? 'No data received.'} If Hydra was updated, restart the background service to enable it.
          </p>
        </div>
      </div>
    )
  }

  if (allSessions.length === 0) {
    return (
      <div className={styles.overview}>
        <div className={styles.centered}>
          <p className={styles.emptyTitle}>No agents yet</p>
          <p className={styles.errorText}>Start an agent and its status shows up here.</p>
          {onOpenNewAgent && (
            <button className={styles.primaryBtn} onClick={onOpenNewAgent}>
              New Agent
            </button>
          )}
        </div>
      </div>
    )
  }

  const needsYou = sessions.filter((s) => s.status === 'needs-you')

  return (
    <div className={styles.overview}>
      <div className={styles.topBar}>
        <h2 className={styles.title}>Overview</h2>
        <span className={styles.summary}>
          {plural(sessions.length, 'agent', 'agents')}
          {counts.needsYou > 0 && ` · ${counts.needsYou} need you`}
          {counts.working > 0 && ` · ${counts.working} working`}
        </span>
        <div className={styles.spacer} />
        <label className={styles.filter}>
          <span className={styles.filterLabel}>Project</span>
          <select
            className={styles.select}
            value={filter}
            onChange={(e) => handleFilterChange(e.target.value)}
            aria-label="Project filter"
            title={filter === ALL_PROJECTS ? 'All projects' : filter}
          >
            <option value={ALL_PROJECTS}>All projects</option>
            {projectDirs.map((dir) => (
              <option key={dir} value={dir} title={dir}>
                {projectName(dir)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.grid}>
        <Card title="Needs you" area="needs" meta={counts.needsYou > 0 ? counts.needsYou : undefined}>
          {needsYou.length === 0 ? (
            <EmptyState>Nothing needs you</EmptyState>
          ) : (
            <ul className={styles.list}>
              {needsYou.map((s) => (
                <li key={s.agentId} className={styles.row}>
                  <span className={styles.rowName}>{s.name}</span>
                  <span className={styles.rowMeta}>{projectName(s.projectDir)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Last hour" area="lastHour">
          <EmptyState>No history yet</EmptyState>
        </Card>

        <Card title="Sessions" area="sessions" meta={sessions.length}>
          {sessions.length === 0 ? (
            <EmptyState>No agents in this project</EmptyState>
          ) : (
            <ul className={styles.list}>
              {sessions.map((s) => (
                <li key={s.agentId} className={styles.row}>
                  <span className={`${styles.dot} ${styles[`dot_${s.status.replace('-', '_')}`]}`} aria-hidden="true" />
                  <span className={styles.rowName}>{s.name}</span>
                  <span className={styles.rowStatus}>{statusLabel(s)}</span>
                  <span className={styles.rowMeta} title={s.projectDir}>
                    {projectName(s.projectDir)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Events" area="events">
          <EmptyState>No events yet</EmptyState>
        </Card>

        <Card title="Timeline" area="timeline">
          <EmptyState>No history yet</EmptyState>
        </Card>

        <Card title="Waits" area="waits">
          <EmptyState>No waits recorded yet</EmptyState>
        </Card>
      </div>
    </div>
  )
}
