import { useCallback, useMemo, useRef, useState } from 'react'
import type { HistoryAgent } from '@shared/overview/types'
import type { CountKey } from '@shared/overview/buckets'
import { computeCounts } from '@shared/overview/status'
import { useOverview } from '@/hooks/useOverview'
import { useOverviewHistory } from '@/hooks/useOverviewHistory'
import { Card, EmptyState } from './Card'
import { CountHistory } from './CountHistory'
import { CountsRow } from './CountsRow'
import { projectName } from './format'
import { lastWaitFrom } from './historyFacts'
import { LastHourChart } from './LastHourChart'
import { NeedsYouPanel } from './NeedsYouPanel'
import { OwnEvents } from './OwnEvents'
import { SessionDetails } from './SessionDetails'
import { SessionsCard } from './SessionsCard'
import { OwnTimeline, TimelineCard } from './TimelineCard'
import styles from './OverviewView.module.css'

const FILTER_STORAGE_KEY = 'hydra.overview.projectFilter'
const ALL_PROJECTS = ''
const NO_AGENTS: Record<string, HistoryAgent> = {}

export { projectName }

interface OverviewViewProps {
  /** Selects the agent (and its project) and switches to the Chat view. */
  onJumpToAgent?: (agentId: string) => void
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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function OverviewView({ onOpenNewAgent, onJumpToAgent }: OverviewViewProps) {
  const { snapshot, loading, error, now } = useOverview()
  const { history } = useOverviewHistory()
  const [storedFilter, setStoredFilter] = useState<string>(readStoredFilter)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chartKey, setChartKey] = useState<CountKey | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const chartTriggerRef = useRef<HTMLElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  const openDetails = useCallback((agentId: string, trigger: HTMLElement | null) => {
    triggerRef.current = trigger
    setSelectedId(agentId)
  }, [])

  // Esc or the close button: back to the row (or card) that opened the drawer.
  const closeDetails = useCallback(() => {
    const agentId = selectedId
    setSelectedId(null)
    const trigger =
      triggerRef.current?.isConnected === true
        ? triggerRef.current
        : rootRef.current?.querySelector<HTMLElement>(`[data-session-trigger="${agentId}"]`)
    trigger?.focus()
  }, [selectedId])

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
  const historyEvents = history?.events
  const lastWait = useMemo(() => {
    if (!historyEvents) return undefined
    const ids = new Set(sessions.map((s) => s.agentId))
    return lastWaitFrom(historyEvents.filter((e) => ids.has(e.agentId)), now)
  }, [historyEvents, sessions, now])

  const historyAgents = history?.agents
  // Same identity until the filter or the known agents change, so the chart math can be memoized.
  const agentFilter = useMemo(
    () =>
      filter === ALL_PROJECTS
        ? undefined
        : (agentId: string) => historyAgents?.[agentId]?.projectDir === filter,
    [filter, historyAgents]
  )
  const historyPoints = history?.points
  const historyStarts = history?.starts
  const noPoints = useMemo<never[]>(() => [], [])

  const toggleChart = useCallback((key: CountKey, trigger: HTMLElement) => {
    chartTriggerRef.current = trigger
    setChartKey((current) => (current === key ? null : key))
  }, [])

  // Esc or the close button: back to the count that opened the chart.
  const closeChart = useCallback(() => {
    setChartKey(null)
    const trigger = chartTriggerRef.current
    if (trigger?.isConnected) trigger.focus()
  }, [])

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
  const multipleProviders = new Set(allSessions.map((s) => s.provider)).size > 1
  const jump = (agentId: string) => onJumpToAgent?.(agentId)

  return (
    <div className={styles.overview} ref={rootRef}>
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
        <Card
          title="Needs you"
          area="needs"
          meta={counts.needsYou > 0 ? counts.needsYou : undefined}
          onTitleClick={(el) => toggleChart('needsYou', el)}
          titleExpanded={chartKey === 'needsYou'}
          titleLabel="Needs you history"
        >
          <div className={styles.needsBody}>
            <NeedsYouPanel
              sessions={needsYou}
              now={now}
              showProvider={multipleProviders}
              onJumpToAgent={jump}
              onOpenDetails={openDetails}
              lastWait={lastWait}
            />
            <CountsRow counts={counts} onOpenChart={toggleChart} openChart={chartKey} />
            {chartKey && (
              <CountHistory
                key={chartKey}
                metric={chartKey}
                points={historyPoints ?? noPoints}
                starts={historyStarts ?? noPoints}
                now={now}
                agentFilter={agentFilter}
                onClose={closeChart}
              />
            )}
          </div>
        </Card>

        <Card title="Last hour" area="lastHour">
          {historyPoints && historyStarts ? (
            <LastHourChart points={historyPoints} starts={historyStarts} now={now} agentFilter={agentFilter} />
          ) : (
            <EmptyState>No history yet</EmptyState>
          )}
        </Card>

        <SessionsCard
          sessions={sessions}
          now={now}
          showProvider={multipleProviders}
          selectedId={selectedId}
          onOpenDetails={openDetails}
          onJumpToAgent={jump}
        />

        <Card title="Events" area="events">
          <EmptyState>No events yet</EmptyState>
        </Card>

        <TimelineCard
          points={historyPoints ?? noPoints}
          starts={historyStarts ?? noPoints}
          now={now}
          agents={historyAgents ?? NO_AGENTS}
          agentFilter={agentFilter}
        />

        <Card title="Waits" area="waits">
          <EmptyState>No waits recorded yet</EmptyState>
        </Card>
      </div>

      {selectedId && (
        <SessionDetails
          key={selectedId}
          agentId={selectedId}
          session={allSessions.find((x) => x.agentId === selectedId)}
          now={now}
          onClose={closeDetails}
          onJumpToAgent={jump}
          ownEvents={<OwnEvents events={history?.events ?? []} agentId={selectedId} now={now} />}
          timelineRow={
            <OwnTimeline
              points={historyPoints ?? noPoints}
              starts={historyStarts ?? noPoints}
              now={now}
              agentId={selectedId}
            />
          }
        />
      )}
    </div>
  )
}
