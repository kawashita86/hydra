import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentDetailsReader } from './agentDetails'

describe('AgentDetailsReader', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hydra-details-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function transcript(sessionId: string, lines: unknown[]): void {
    const dir = join(root, 'projects', '-work-alpha')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  const reader = () => new AgentDetailsReader(() => [join(root, 'projects')])

  it('reads the last message and tokens of a Claude session', () => {
    transcript('s1', [
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'text', text: 'All done.' }],
          usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 5 }
        }
      }
    ])
    expect(reader().read({ provider: 'claude', sessionId: 's1', projectDir: '/work/alpha' })).toEqual({
      lastMessage: { text: 'All done.', truncated: false },
      tokens: { input: 10, cached: 7, output: 5 }
    })
  })

  it('says why nothing is available', () => {
    expect(reader().read({ provider: 'claude', sessionId: 'missing', projectDir: '/x' }).lastMessage).toEqual({
      unavailable: 'The transcript was not found'
    })
    expect(reader().read({ provider: 'claude', sessionId: null, projectDir: '/x' }).tokens).toBeNull()
    expect(reader().read({ provider: 'codex', sessionId: 's', projectDir: '/x' }).lastMessage).toEqual({
      unavailable: 'not supported for this provider'
    })
  })
})
