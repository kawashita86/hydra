import type { ViewMode } from '@shared/types'
import styles from './ViewSwitcher.module.css'

interface ViewSwitcherProps {
  viewMode: ViewMode
  onSelect: (mode: ViewMode) => void
}

export function ViewSwitcher({ viewMode, onSelect }: ViewSwitcherProps) {
  const tabs: { mode: ViewMode; label: string; icon: JSX.Element }[] = [
    { mode: 'grid', label: 'Grid', icon: <GridIcon /> },
    { mode: 'chat', label: 'Chat', icon: <ChatIcon /> },
    { mode: 'overview', label: 'Overview', icon: <OverviewIcon /> }
  ]
  return (
    <div className={styles.switcher} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.mode}
          className={`${styles.tab} ${viewMode === tab.mode ? styles.active : ''}`}
          onClick={() => onSelect(tab.mode)}
          role="tab"
          aria-selected={viewMode === tab.mode}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function OverviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="4" y2="11" />
      <line x1="10" y1="20" x2="10" y2="4" />
      <line x1="16" y1="20" x2="16" y2="14" />
      <line x1="22" y1="20" x2="2" y2="20" />
    </svg>
  )
}
