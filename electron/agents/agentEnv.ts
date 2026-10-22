/**
 * Variables a running Claude Code session sets for its own children. When Hydra
 * is launched from inside a Claude Code session they leak into every agent, and
 * `CLAUDE_CODE_CHILD_SESSION` in particular makes Claude treat the agent as a
 * sub-session and stop saving its transcript. User-level settings such as
 * `CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_USE_BEDROCK` are deliberately kept.
 */
export const PARENT_SESSION_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_JOB_DIR',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN'
] as const

/** Environment for a spawned agent CLI: Hydra's env minus parent-session markers, plus overrides. */
export function buildAgentEnv(
  overrides: Record<string, string> = {},
  baseEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of PARENT_SESSION_ENV_VARS) delete env[key]
  return { ...env, ...overrides }
}
