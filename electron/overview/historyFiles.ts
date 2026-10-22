// Adapted from agent-lookout (MIT, © 2026 Idris Olubisi): src/collector/history/historyFiles.ts
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeSync, lstatSync } from 'fs'

/** What is at a path, without following a link. `file` is an ordinary file. */
export interface PathInfo {
  kind: 'file' | 'other'
  size: number
}

/**
 * Everything the history does to the file system, in its own folder and
 * nowhere else. Synchronous: writes are small, and `stop()` must be able to
 * flush before the process exits. Tests replace it with a folder in memory.
 *
 * No method follows a link at the file's own name: a link, a pipe, a device
 * or a folder where a history file should be is never read, written or deleted.
 */
export interface HistoryFs {
  /** Makes the folder (and parents) with mode 700. */
  makeFolder(dir: string): void
  /** The names in a folder. Throws when it cannot list it. */
  list(dir: string): string[]
  /** What is at a path without following a link, `null` when nothing is there. */
  stat(file: string): PathInfo | null
  /** The text of an ordinary file of at most `maxBytes`. Throws for anything else. */
  read(file: string, maxBytes: number): string
  /** Adds to the end of an ordinary file, making it with mode 600 when it is not there. */
  append(file: string, text: string): void
  /** Deletes an ordinary file. One that is not there is no error. */
  remove(file: string): void
}

export const FILE_MODE = 0o600
export const FOLDER_MODE = 0o700

// O_NOFOLLOW does not exist on Windows; O_NONBLOCK keeps a named pipe from blocking the open.
const NO_FOLLOW = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

function notOrdinary(): Error {
  return new Error('Not an ordinary file.')
}

export const nodeHistoryFs: HistoryFs = {
  makeFolder(dir) {
    mkdirSync(dir, { recursive: true, mode: FOLDER_MODE })
  },
  list: (dir) => readdirSync(dir),
  stat(file) {
    try {
      const info = lstatSync(file)
      return { kind: info.isFile() ? 'file' : 'other', size: info.size }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  read(file, maxBytes) {
    const fd = openSync(file, constants.O_RDONLY | NO_FOLLOW)
    try {
      const info = fstatSync(fd)
      if (!info.isFile()) throw notOrdinary()
      if (info.size > maxBytes) throw new Error('Too large to be a history file.')
      const buffer = Buffer.alloc(info.size)
      let filled = 0
      while (filled < buffer.byteLength) {
        const n = readSync(fd, buffer, filled, buffer.byteLength - filled, filled)
        if (n === 0) break
        filled += n
      }
      return buffer.toString('utf8', 0, filled)
    } finally {
      closeSync(fd)
    }
  },
  append(file, text) {
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW, FILE_MODE)
    try {
      if (!fstatSync(fd).isFile()) throw notOrdinary()
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
  },
  remove(file) {
    try {
      if (lstatSync(file).isDirectory()) return
      unlinkSync(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
