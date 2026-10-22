import type { ReactNode } from 'react'
import styles from './OverviewView.module.css'

interface CardProps {
  title: string
  /** Grid area name, see OverviewView.module.css. */
  area: 'needs' | 'lastHour' | 'sessions' | 'events' | 'timeline' | 'waits'
  /** Short text on the right of the title. */
  meta?: ReactNode
  children: ReactNode
}

export function Card({ title, area, meta, children }: CardProps) {
  return (
    <section className={`${styles.card} ${styles[area]}`} aria-label={title}>
      <header className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{title}</h3>
        {meta !== undefined && <span className={styles.cardMeta}>{meta}</span>}
      </header>
      <div className={styles.cardBody}>{children}</div>
    </section>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>
}
