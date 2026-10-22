import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'

// Adapted from agent-lookout (MIT, © 2026 Idris Olubisi): src/collector/git/repository.ts, gitHead.ts

export interface GitInfo {
  /** Main working folder, or the bare repository folder (the container for `.bare`). */
  repoRoot: string
  repoName: string
  branch: string | null
  /** Short commit id, only when HEAD is detached. */
  commit: string | null
}

/** Files are one short line; a larger one gives no answer. */
const MAX_GIT_FILE_BYTES = 4 * 1024
const SHORT_COMMIT_LENGTH = 7
const MAX_BRANCH_LENGTH = 100
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const BRANCH_REF = 'refs/heads/'
const MAX_WALK_UP = 64
// Control characters and bidi reordering marks, which git allows in a branch name.
// eslint-disable-next-line no-control-regex
const UNSAFE_BRANCH_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]', 'g')

function readSmallFile(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_GIT_FILE_BYTES) return null
    const buffer = Buffer.alloc(stat.size)
    const n = readSync(fd, buffer, 0, stat.size, 0)
    return buffer.toString('utf-8', 0, n)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function oneLine(content: string): string | null {
  const line = content.replace(/\r?\n$/, '')
  return /[\r\n]/.test(line) ? null : line
}

function pathIn(text: string): string | null {
  const target = text.trim()
  // eslint-disable-next-line no-control-regex
  return target === '' || /[\u0000-\u001f\u007f-\u009f]/.test(target) ? null : target
}

/** `HEAD`: the branch, or the short commit id when detached; null for anything else. */
export function parseHead(content: string): { branch: string | null; commit: string | null } | null {
  const line = oneLine(content)
  if (line === null) return null
  if (line.startsWith('ref:')) {
    const ref = line.slice('ref:'.length).trim()
    if (!ref.startsWith(BRANCH_REF)) return null
    const branch = ref.slice(BRANCH_REF.length).replace(UNSAFE_BRANCH_CHARS, '')
    return branch === '' ? null : { branch: branch.slice(0, MAX_BRANCH_LENGTH), commit: null }
  }
  const id = line.trim()
  return COMMIT_ID.test(id) ? { branch: null, commit: id.slice(0, SHORT_COMMIT_LENGTH) } : null
}

/** The path a `.git` file (`gitdir: <path>`) names, or null. */
export function parseGitFile(content: string): string | null {
  const line = oneLine(content)
  if (line === null || !line.startsWith('gitdir:')) return null
  return pathIn(line.slice('gitdir:'.length))
}

function resolveFrom(base: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(base, target)
}

/** Name of a shared git folder: the folder holding it when hidden (`.git`, `.bare`), else its name without `.git`. */
function sharedName(common: string): string {
  const base = basename(common)
  if (base.startsWith('.')) return basename(dirname(common))
  return base.endsWith('.git') ? base.slice(0, -'.git'.length) : base
}

function sharedRoot(common: string): string {
  return basename(common).startsWith('.') ? dirname(common) : common
}

/**
 * Reads repository, branch and commit of a folder from git's own files, without
 * running git. Walks up to the nearest `.git` (folder, or file naming the git
 * folder); a worktree's `commondir` leads to the repository it belongs to.
 * Returns null when there is no repository or nothing could be read.
 */
export function readGitInfo(projectDir: string): GitInfo | null {
  try {
    let dir = resolve(projectDir)
    for (let i = 0; i < MAX_WALK_UP; i += 1) {
      const dotGit = join(dir, '.git')
      let stat
      try {
        stat = lstatSync(dotGit)
      } catch {
        stat = null
      }
      if (stat?.isDirectory()) return infoFor(dir, dotGit, null)
      if (stat?.isFile()) {
        const content = readSmallFile(dotGit)
        const target = content === null ? null : parseGitFile(content)
        if (target === null) return null
        const gitDir = resolveFrom(dir, target)
        const commonFile = readSmallFile(join(gitDir, 'commondir'))
        const commonLine = commonFile === null ? null : oneLine(commonFile)
        const commonTarget = commonLine === null ? null : pathIn(commonLine)
        const commonDir = commonTarget === null ? null : resolveFrom(gitDir, commonTarget)
        return infoFor(dir, gitDir, commonDir)
      }
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  } catch {
    return null
  }
}

function infoFor(dir: string, gitDir: string, commonDir: string | null): GitInfo | null {
  const repoName = commonDir === null ? basename(dir) : sharedName(commonDir)
  if (repoName === '') return null
  const repoRoot = commonDir === null ? dir : sharedRoot(commonDir)
  const headFile = readSmallFile(join(gitDir, 'HEAD'))
  const head = headFile === null ? null : parseHead(headFile)
  return { repoRoot, repoName, branch: head?.branch ?? null, commit: head?.commit ?? null }
}

export const GIT_INFO_REFRESH_MS = 10_000

/** Caches `readGitInfo` per project folder, re-reading at most every 10 s. */
export class GitInfoCache {
  private readonly entries = new Map<string, { at: number; info: GitInfo | null }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly read: (dir: string) => GitInfo | null = readGitInfo,
    private readonly refreshMs: number = GIT_INFO_REFRESH_MS
  ) {}

  get(projectDir: string): GitInfo | null {
    const now = this.now()
    const cached = this.entries.get(projectDir)
    if (cached && now - cached.at < this.refreshMs) return cached.info
    const info = this.read(projectDir)
    this.entries.set(projectDir, { at: now, info })
    return info
  }

  /** Drops the folders not in `projectDirs`. */
  retain(projectDirs: Iterable<string>): void {
    const keep = new Set(projectDirs)
    for (const dir of [...this.entries.keys()]) {
      if (!keep.has(dir)) this.entries.delete(dir)
    }
  }
}
