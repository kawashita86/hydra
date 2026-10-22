import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'fs'
import { join } from 'path'
import { lastAskFromTail } from '@shared/overview/waitingText'
import { findClaudeTranscriptFile } from '../sessions/TranscriptReader'
import { discoverClaudeProjectsDirs } from '../sessions/claudeProfiles'

// Modelled on agent-lookout (MIT, © 2026 Idris Olubisi): src/collector/files/transcriptTail.ts

/** How much of the end of a transcript is read. */
export const MAX_TAIL_BYTES = 256 * 1024

export interface WaitingTextAgent {
  agentId: string
  sessionId: string
  projectDir: string
  /** Claude config dir of the matched profile; its `projects/` is searched first. */
  configDir?: string
}

export interface WaitingTextReaderOptions {
  /** `projects` dirs to search after the agent's own profile. Default: every discovered profile. */
  projectsDirs?: () => string[]
}

interface CacheEntry {
  key: string
  sessionId: string
  path: string
  text: string | null
}

/**
 * Works out what a waiting Claude session asks from the last 256 KB of its
 * transcript. Reads regular files only, and caches per agent until the file changes.
 */
export class WaitingTextReader {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly projectsDirs: () => string[]

  constructor(options: WaitingTextReaderOptions = {}) {
    this.projectsDirs = options.projectsDirs ?? (() => discoverClaudeProjectsDirs())
  }

  read(agent: WaitingTextAgent): string | null {
    try {
      const cached = this.cache.get(agent.agentId)
      const path = this.locate(agent, cached?.sessionId === agent.sessionId ? cached.path : undefined)
      if (!path) {
        this.cache.delete(agent.agentId)
        return null
      }
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
      const key = `${path}|${stat.size}|${stat.mtimeMs}|${stat.ino}`
      if (cached && cached.key === key) return cached.text
      const text = this.readTail(path, agent.projectDir)
      if (text === undefined) return null
      this.cache.set(agent.agentId, { key, sessionId: agent.sessionId, path, text })
      return text
    } catch {
      return null
    }
  }

  forget(agentId: string): void {
    this.cache.delete(agentId)
  }

  /** Drops the cache of every agent not in `agentIds`. */
  retain(agentIds: Iterable<string>): void {
    const keep = new Set(agentIds)
    for (const id of [...this.cache.keys()]) {
      if (!keep.has(id)) this.cache.delete(id)
    }
  }

  private locate(agent: WaitingTextAgent, known?: string): string | null {
    return locateClaudeTranscript(agent.sessionId, agent.configDir, this.projectsDirs, known)
  }

  /** Reads the tail through a descriptor opened without following symlinks. */
  private readTail(path: string, projectDir: string): string | null | undefined {
    const tail = readTranscriptTail(path)
    return tail === undefined ? undefined : lastAskFromTail(tail.text, tail.wholeFile, projectDir)
  }
}

/** Finds the transcript of a session: `known` if it still exists, then the agent's own profile, then every profile. */
export function locateClaudeTranscript(
  sessionId: string,
  configDir: string | undefined,
  projectsDirs: () => string[],
  known?: string
): string | null {
  if (known) {
    try {
      if (lstatSync(known).isFile()) return known
    } catch {
      // Moved or removed: search again.
    }
  }
  const dirs = [...(configDir ? [join(configDir, 'projects')] : []), ...projectsDirs()]
  for (const dir of new Set(dirs)) {
    const found = findClaudeTranscriptFile(sessionId, dir)
    if (found) return found
  }
  return null
}

/**
 * Reads the last 256 KB of a regular file through a descriptor opened without
 * following symlinks. `undefined` when it is not a regular file.
 */
export function readTranscriptTail(path: string): { text: string; wholeFile: boolean } | undefined {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return undefined
    const length = Math.min(stat.size, MAX_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const n = readSync(fd, buffer, done, length - done, stat.size - length + done)
      if (n <= 0) break
      done += n
    }
    return { text: buffer.toString('utf-8', 0, done), wholeFile: stat.size <= MAX_TAIL_BYTES }
  } finally {
    closeSync(fd)
  }
}
