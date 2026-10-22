/**
 * Formats a duration for timers: `45s`, `4m 12s`, `1h 03m`.
 * With `compact`, seconds are dropped from a minute on: `12m`, `1h 03m`.
 */
export function formatDuration(ms: number, options: { compact?: boolean } = {}): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return options.compact ? `${minutes}m` : `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** Last path segment of a project directory. */
export function projectName(projectDir: string): string {
  const parts = projectDir.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? projectDir
}

/** Absolute time for a timestamp: `14:02:11`, with the date when it is not today. */
export function formatClock(at: number, now: number = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/** `182431` -> `182,431`. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
