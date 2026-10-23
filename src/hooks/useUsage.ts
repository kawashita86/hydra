import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsagePeriod, UsageState, UsageSummary } from '@shared/usage/types'

/**
 * The usage service state, fetched once and then pushed on change. Owned once in
 * `App` (like the Overview snapshot) and passed down; never subscribe per component.
 */
export function useUsageState(): UsageState | null {
  const [state, setState] = useState<UsageState | null>(null)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.hydra.onUsageChanged((next) => {
      if (!cancelled) setState(next)
    })
    window.hydra
      .getUsageState()
      .then((initial) => {
        // A pushed state may already be newer than the initial response.
        if (!cancelled) setState((prev) => (prev && prev.updatedAt > initial.updatedAt ? prev : initial))
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}

/**
 * The summary of one period for the popover. Fetches while `enabled`, when the period
 * changes and when `dataVersion` changes; keeps showing the last summary of the same
 * period while a refetch runs.
 */
export function useUsageSummary(
  period: UsagePeriod,
  enabled: boolean,
  dataVersion: number | undefined
): { summary: UsageSummary | null; loading: boolean } {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    window.hydra
      .getUsageSummary(period)
      .then((next) => {
        if (!cancelled) setSummary(next)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, enabled, dataVersion])

  return { summary: summary && summary.period === period ? summary : null, loading }
}

/** Epoch ms that updates every `everyMs` (default one minute) while mounted. */
export function useCoarseNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}

/** A choice remembered in localStorage (every access guarded: it can be blocked or empty). */
export function usePersistedChoice<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[]
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return allowed.includes(raw as T) ? (raw as T) : fallback
    } catch {
      return fallback
    }
  })
  const keyRef = useRef(key)
  const set = useCallback((next: T) => {
    setValue(next)
    try {
      localStorage.setItem(keyRef.current, next)
    } catch {
      /* storage unavailable: the choice just is not remembered */
    }
  }, [])
  return [value, set]
}
