import { execFile } from 'child_process'

/** Parent pid by pid, as listed by `ps`. */
export type ProcessTable = Map<number, number>

/** Pids below `rootPid` in the process tree (the root itself excluded). Cycle-safe. */
export function descendantPids(rootPid: number, table: ProcessTable): Set<number> {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of table) {
    if (pid === ppid) continue
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }
  const found = new Set<number>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.pop() as number
    for (const child of children.get(current) ?? []) {
      if (child === rootPid || found.has(child)) continue
      found.add(child)
      queue.push(child)
    }
  }
  return found
}

/** Parses `ps -A -o pid=,ppid=` output; malformed lines are skipped. */
export function parsePsOutput(output: string): ProcessTable {
  const table: ProcessTable = new Map()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) table.set(Number(match[1]), Number(match[2]))
  }
  return table
}

export interface ProcessTableReaderOptions {
  /** Runs `ps` and returns its stdout. Defaults to `execFile` without a shell. */
  runPs?: () => Promise<string>
  now?: () => number
  platform?: NodeJS.Platform
  /** Minimum time between `ps` runs. Default 10 s. */
  minIntervalMs?: number
}

function defaultRunPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })
}

/**
 * Reads the process table at most once per `minIntervalMs`; between runs the last
 * table is returned. Empty on Windows or when `ps` fails.
 */
export class ProcessTableReader {
  private table: ProcessTable = new Map()
  private lastRunAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<ProcessTable> | null = null
  private readonly runPs: () => Promise<string>
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly minIntervalMs: number

  constructor(options: ProcessTableReaderOptions = {}) {
    this.runPs = options.runPs ?? defaultRunPs
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    this.minIntervalMs = options.minIntervalMs ?? 10_000
  }

  async read(): Promise<ProcessTable> {
    if (this.platform === 'win32') return new Map()
    if (this.inflight) return this.inflight
    if (this.now() - this.lastRunAt < this.minIntervalMs) return this.table
    this.lastRunAt = this.now()
    this.inflight = this.runPs()
      .then((output) => {
        this.table = parsePsOutput(output)
        return this.table
      })
      .catch(() => {
        this.table = new Map()
        return this.table
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }
}
