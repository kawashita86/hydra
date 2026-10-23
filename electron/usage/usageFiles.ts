import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { FILE_MODE, nodeHistoryFs } from '../overview/historyFiles'

/** An ordinary log file found by `walk`. */
export interface UsageFileInfo {
  path: string
  size: number
  mtimeMs: number
  ino: number
}

/**
 * Everything the usage store does to the file system. Synchronous, every call
 * bounded (`walk` by depth and file count, reads by `maxBytes`). Like
 * `HistoryFs`, no method follows a link at the file's own name. Tests replace
 * it with files in memory.
 */
export interface UsageFs {
  /** Ordinary `*.jsonl` files under `root` (never through links); a missing root gives `[]`. */
  walk(root: string, maxDepth: number): UsageFileInfo[]
  /** Up to `maxBytes` of an ordinary file from `offset`. Throws for anything else. */
  readChunk(path: string, offset: number, maxBytes: number): Buffer
  /** The text of an ordinary file of at most `maxBytes`; `null` when it is not there. */
  readText(path: string, maxBytes: number): string | null
  /** Writes `<path>.tmp-<pid>` with mode 600, then renames it over `path`. */
  writeAtomic(path: string, text: string): void
  /** Makes the folder (and parents) with mode 700. */
  makeFolder(dir: string): void
}

/** The most files one walk returns. */
export const MAX_WALK_FILES = 50000

// O_NOFOLLOW does not exist on Windows; O_NONBLOCK keeps a named pipe from blocking the open.
const NO_FOLLOW = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

function walkInto(dir: string, depth: number, maxDepth: number, out: UsageFileInfo[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // unreadable or gone: skipped
  }
  for (const entry of entries) {
    if (out.length >= MAX_WALK_FILES) return
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < maxDepth) walkInto(path, depth + 1, maxDepth, out)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const info = lstatSync(path)
        if (info.isFile()) out.push({ path, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino })
      } catch {
        /* vanished */
      }
    }
  }
}

export const nodeUsageFs: UsageFs = {
  walk(root, maxDepth) {
    const out: UsageFileInfo[] = []
    try {
      if (!lstatSync(root).isDirectory()) return out
    } catch {
      return out
    }
    walkInto(root, 0, maxDepth, out)
    return out
  },
  readChunk(path, offset, maxBytes) {
    const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW)
    try {
      const info = fstatSync(fd)
      if (!info.isFile()) throw new Error('Not an ordinary file.')
      const want = Math.max(0, Math.min(maxBytes, info.size - offset))
      const buffer = Buffer.alloc(want)
      let filled = 0
      while (filled < want) {
        const n = readSync(fd, buffer, filled, want - filled, offset + filled)
        if (n === 0) break
        filled += n
      }
      return filled === want ? buffer : buffer.subarray(0, filled)
    } finally {
      closeSync(fd)
    }
  },
  readText(path, maxBytes) {
    try {
      return nodeHistoryFs.read(path, maxBytes)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  writeAtomic(path, text) {
    const tmp = `${path}.tmp-${process.pid}`
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW, FILE_MODE)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Not an ordinary file.')
      writeSync(fd, text)
    } catch (err) {
      closeSync(fd)
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
    closeSync(fd)
    try {
      renameSync(tmp, path)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  },
  makeFolder: (dir) => nodeHistoryFs.makeFolder(dir)
}
