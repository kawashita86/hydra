import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ClaudeSessionSummary } from '@shared/types'
import type { SessionCatalog } from './SessionCatalog'
import {
  createClaudeProfileResolver,
  claudeConfigDirForTranscript,
  discoverClaudeProjectsDirs,
  listClaudeProfiles
} from './claudeProfiles'

const tempDirs: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-claude-profiles-'))
  tempDirs.push(dir)
  return dir
}

describe('claudeProfiles', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds projects dirs of the default profile, ~/.claude-<name> profiles and CLAUDE_CONFIG_DIR', () => {
    const home = makeHome()
    const custom = makeHome()
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-work', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-alternative', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-empty'))
    mkdirSync(join(custom, 'projects'))
    writeFileSync(join(home, '.claude-notes'), '', 'utf-8')

    const dirs = discoverClaudeProjectsDirs(home, { CLAUDE_CONFIG_DIR: custom })
    expect(dirs[0]).toBe(join(home, '.claude', 'projects'))
    expect([...dirs].sort()).toEqual(
      [
        join(home, '.claude', 'projects'),
        join(home, '.claude-alternative', 'projects'),
        join(home, '.claude-work', 'projects'),
        join(custom, 'projects')
      ].sort()
    )
  })

  it('does not list a profile twice when CLAUDE_CONFIG_DIR points at one', () => {
    const home = makeHome()
    mkdirSync(join(home, '.claude-work', 'projects'), { recursive: true })

    const dirs = discoverClaudeProjectsDirs(home, { CLAUDE_CONFIG_DIR: join(home, '.claude-work') })
    expect(dirs).toEqual([join(home, '.claude-work', 'projects')])
  })

  it('labels profiles by their suffix, including ones without sessions yet', () => {
    const home = makeHome()
    mkdirSync(join(home, '.claude'))
    mkdirSync(join(home, '.claude-work'))

    const profiles = listClaudeProfiles(home, {})
    expect(profiles).toEqual([
      { configDir: join(home, '.claude'), label: 'default', isDefault: true },
      { configDir: join(home, '.claude-work'), label: 'work', isDefault: false }
    ])
  })

  it('maps a transcript path back to its profile', () => {
    const home = '/home/me'
    expect(claudeConfigDirForTranscript('/home/me/.claude-work/projects/-var-www-test/abc.jsonl', home)).toBe(
      '/home/me/.claude-work'
    )
    expect(claudeConfigDirForTranscript('/home/me/.claude/projects/-tmp/abc.jsonl', home)).toBe('')
  })

  it('resumes a session in the profile that saved it, otherwise follows the project mapping', () => {
    const session = {
      sessionId: 'session-work',
      projectPath: '/var/www/test',
      firstPrompt: '',
      messageCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      gitBranch: null,
      isSidechain: false,
      sourcePath: '/home/me/.claude-work/projects/-var-www-test/session-work.jsonl'
    } satisfies ClaudeSessionSummary
    const catalog = { listSessions: () => [session] } as unknown as SessionCatalog
    const resolve = createClaudeProfileResolver(catalog, () => ({ '/var/www/test': '/home/me/.claude-alternative' }))

    expect(resolve('/var/www/test', 'session-work')).toBe('/home/me/.claude-work')
    expect(resolve('/var/www/test', null)).toBe('/home/me/.claude-alternative')
    expect(resolve('/var/www/test', 'unknown-session')).toBe('/home/me/.claude-alternative')
    expect(resolve('/elsewhere', null)).toBeNull()
  })
})
