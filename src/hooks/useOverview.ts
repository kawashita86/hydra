import { useEffect, useState } from 'react'
import type { OverviewSnapshot } from '@shared/overview/types'

export interface UseOverviewResult {
  snapshot: OverviewSnapshot | null
  loading: boolean
  error: string | null
  /** Epoch ms, ticks every second while mounted (for live timers). */
  now: number
}

export function useOverview(): UseOverviewResult {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.hydra.onOverviewSnapshot((next) => {
      if (cancelled) return
      setSnapshot(next)
      setError(null)
      setLoading(false)
    })

    window.hydra
      .getOverview()
      .then((initial) => {
        if (cancelled) return
        // A pushed snapshot may already be newer than the initial response.
        setSnapshot((prev) => (prev && prev.at > initial.at ? prev : initial))
        setError(null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  return { snapshot, loading, error, now }
}
