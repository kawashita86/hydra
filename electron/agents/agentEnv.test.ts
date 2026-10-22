import { describe, expect, it } from 'vitest'
import { buildAgentEnv } from './agentEnv'

describe('buildAgentEnv', () => {
  it('drops markers leaked from a parent Claude Code session', () => {
    const env = buildAgentEnv(
      { FORCE_COLOR: '1' },
      {
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_JOB_DIR: '/home/me/.claude/jobs/abc'
      }
    )
    expect(env).toEqual({ PATH: '/usr/bin', FORCE_COLOR: '1' })
  })

  it('keeps user-level Claude settings', () => {
    const env = buildAgentEnv(
      {},
      { CLAUDE_CONFIG_DIR: '/home/me/.claude-work', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'opus' }
    )
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'opus'
    })
  })

  it('lets overrides win', () => {
    expect(buildAgentEnv({ TERM: 'xterm-256color' }, { TERM: 'dumb' })).toEqual({ TERM: 'xterm-256color' })
  })
})
