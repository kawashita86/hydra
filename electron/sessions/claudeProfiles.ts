import { existsSync, readdirSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'
import type { ClaudeProfile } from '@shared/types'
import { resolveClaudeProfile } from '@shared/claudeProfiles'
import type { SessionCatalog } from './SessionCatalog'

/**
 * Every Claude Code config dir on this machine: the default `~/.claude`,
 * `$CLAUDE_CONFIG_DIR` when set, and alternate profiles kept as `~/.claude-<name>`
 * (e.g. `CLAUDE_CONFIG_DIR=~/.claude-work claude`). Missing dirs are skipped.
 */
export function discoverClaudeConfigDirs(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const configDirs = [join(home, '.claude')]
  if (env.CLAUDE_CONFIG_DIR) configDirs.push(resolve(env.CLAUDE_CONFIG_DIR))
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.claude-.+/.test(entry.name)) {
        configDirs.push(join(home, entry.name))
      }
    }
  } catch {
    // Unreadable home dir: fall back to the default profile only.
  }
  return [...new Set(configDirs)].filter((dir) => existsSync(dir))
}

/** The `projects` dir of every Claude Code profile, where session transcripts live. */
export function discoverClaudeProjectsDirs(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return discoverClaudeConfigDirs(home, env)
    .map((dir) => join(dir, 'projects'))
    .filter((dir) => existsSync(dir))
}

/** Profiles the user can pick from, labelled by their `~/.claude-<name>` suffix. */
export function listClaudeProfiles(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): ClaudeProfile[] {
  const defaultDir = join(home, '.claude')
  return discoverClaudeConfigDirs(home, env).map((configDir) => {
    const name = basename(configDir)
    const isDefault = configDir === defaultDir
    const label = isDefault ? 'default' : name.startsWith('.claude-') ? name.slice('.claude-'.length) : name
    return { configDir, label, isDefault }
  })
}

/**
 * The profile a transcript belongs to: `<configDir>/projects/<project>/<id>.jsonl`.
 * Returns `''` for the default `~/.claude` profile, matching the project mapping.
 */
export function claudeConfigDirForTranscript(transcriptPath: string, home: string = homedir()): string {
  const configDir = dirname(dirname(dirname(transcriptPath)))
  return configDir === join(home, '.claude') ? '' : configDir
}

/** Picks the Claude config dir for an agent; `null` keeps Hydra's own environment. */
export type ClaudeProfileResolver = (projectDir: string, sessionId: string | null) => string | null

/**
 * A resumed session only exists in the profile that saved it, so it wins over the
 * project mapping; new sessions follow the project (or nearest parent) mapping.
 */
export function createClaudeProfileResolver(
  sessionCatalog: SessionCatalog,
  getProfileByProject: () => Record<string, string>
): ClaudeProfileResolver {
  return (projectDir, sessionId) => {
    if (sessionId) {
      const session = sessionCatalog.listSessions().find((entry) => entry.sessionId === sessionId)
      if (session) return claudeConfigDirForTranscript(session.sourcePath)
    }
    return resolveClaudeProfile(projectDir, getProfileByProject())
  }
}
