import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitInfoCache, parseHead, readGitInfo } from './gitInfo'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

describe('gitInfo', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hydra-git-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads a normal repository from a subfolder', () => {
    const repo = join(root, 'shop')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/cart\n')
    expect(readGitInfo(join(repo, 'src', 'deep'))).toEqual({
      repoRoot: repo,
      repoName: 'shop',
      branch: 'feat/cart',
      commit: null
    })
  })

  it('groups a worktree under its main repository', () => {
    const repo = join(root, 'shop')
    const wtGit = join(repo, '.git', 'worktrees', 'wt')
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/fix\n')
    writeFileSync(join(wtGit, 'commondir'), '../..\n')
    const wt = join(root, 'wt-folder')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`)
    expect(readGitInfo(wt)).toEqual({ repoRoot: repo, repoName: 'shop', branch: 'fix', commit: null })
  })

  it('names a repository after the folder beside .bare', () => {
    const bare = join(root, 'storefront', '.bare')
    const wtGit = join(bare, 'worktrees', 'main')
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(wtGit, 'commondir'), '../..\n')
    const wt = join(root, 'storefront', 'main')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), 'gitdir: ../.bare/worktrees/main\n')
    expect(readGitInfo(wt)).toMatchObject({ repoName: 'storefront', repoRoot: join(root, 'storefront'), branch: 'main' })
  })

  it('strips .git from a bare repository name', () => {
    const bare = join(root, 'tool.git')
    const wtGit = join(bare, 'worktrees', 'a')
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/a\n')
    writeFileSync(join(wtGit, 'commondir'), '../..')
    const wt = join(root, 'a')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}`)
    expect(readGitInfo(wt)).toMatchObject({ repoName: 'tool', repoRoot: bare })
  })

  it('reports a detached HEAD as a short commit', () => {
    const repo = join(root, 'r')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), `${SHA}\n`)
    expect(readGitInfo(repo)).toMatchObject({ branch: null, commit: 'a1b2c3d' })
  })

  it('returns null outside a repository and for an unreadable .git file', () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(readGitInfo(plain)).toBeNull()
    const odd = join(root, 'odd')
    mkdirSync(odd)
    writeFileSync(join(odd, '.git'), 'nonsense')
    expect(readGitInfo(odd)).toBeNull()
  })

  it('parses HEAD strictly', () => {
    expect(parseHead('ref: refs/tags/v1\n')).toBeNull()
    expect(parseHead('garbage')).toBeNull()
    expect(parseHead('ref: refs/heads/a\nb')).toBeNull()
  })
})

describe('GitInfoCache', () => {
  it('re-reads at most every 10 s', () => {
    let now = 1000
    const read = vi.fn(() => null)
    const cache = new GitInfoCache(() => now, read)
    cache.get('/a')
    now += 9000
    cache.get('/a')
    expect(read).toHaveBeenCalledTimes(1)
    now += 2000
    cache.get('/a')
    expect(read).toHaveBeenCalledTimes(2)
    cache.get('/b')
    expect(read).toHaveBeenCalledTimes(3)
  })
})
