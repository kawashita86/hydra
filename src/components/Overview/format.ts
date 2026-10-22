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
