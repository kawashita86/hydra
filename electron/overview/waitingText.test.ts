import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_TAIL_BYTES, WaitingTextReader } from './waitingText'

const bash = (cmd: string, id = 'a'): string =>
  JSON.stringify({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } })
const filler = (): string => JSON.stringify({ type: 'attachment', pad: 'x'.repeat(1000) })

describe('WaitingTextReader', () => {
  let root: string
  let projects: string
  let file: string
  let reader: WaitingTextReader
  const agent = { agentId: 'ag', sessionId: 's1', projectDir: '/work/proj' }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hydra-wt-'))
    projects = join(root, 'projects')
    mkdirSync(join(projects, 'p'), { recursive: true })
    file = join(projects, 'p', 's1.jsonl')
    reader = new WaitingTextReader({ projectsDirs: () => [projects] })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads the pending ask and caches while the file is unchanged', () => {
    writeFileSync(file, bash('npm test') + '\n')
    expect(reader.read(agent)).toBe('Run: npm test')
    // Same size and mtime, different content: the cache answers.
    const stamp = new Date(Date.now() - 5000)
    writeFileSync(file, bash('npm bust') + '\n')
    utimesSync(file, stamp, stamp)
    expect(reader.read(agent)).toBe('Run: npm bust')
    writeFileSync(file, bash('npm tesx') + '\n')
    utimesSync(file, stamp, stamp)
    expect(reader.read(agent)).toBe('Run: npm bust')
  })

  it('re-reads when the file changes, and forgets', () => {
    writeFileSync(file, bash('ls') + '\n')
    expect(reader.read(agent)).toBe('Run: ls')
    appendFileSync(file, bash('pwd', 'b') + '\n')
    expect(reader.read(agent)).toBe('Run: pwd')
    reader.forget('ag')
    writeFileSync(file, bash('whoami') + '\n')
    expect(reader.read(agent)).toBe('Run: whoami')
  })

  it('searches the agent profile first and returns null when missing', () => {
    const cfg = join(root, 'cfg')
    mkdirSync(join(cfg, 'projects', 'q'), { recursive: true })
    writeFileSync(join(cfg, 'projects', 'q', 's2.jsonl'), bash('from cfg') + '\n')
    expect(reader.read({ ...agent, sessionId: 's2', configDir: cfg })).toBe('Run: from cfg')
    expect(reader.read({ ...agent, sessionId: 'nope' })).toBeNull()
  })

  it('refuses a symlinked transcript', () => {
    const real = join(root, 'real.jsonl')
    writeFileSync(real, bash('ls') + '\n')
    symlinkSync(real, file)
    expect(reader.read(agent)).toBeNull()
  })

  it('reads only the tail of a large file', () => {
    const lines: string[] = [bash('old', 'old'), JSON.stringify({ type: 'user', message: { content: 'go' } })]
    let size = 0
    while (size < MAX_TAIL_BYTES * 2) {
      const f = filler()
      lines.push(f)
      size += f.length + 1
    }
    lines.push(bash('latest', 'new'))
    writeFileSync(file, lines.join('\n') + '\n')
    expect(reader.read(agent)).toBe('Run: latest')
  })

  it('retain drops other agents from the cache', () => {
    writeFileSync(file, bash('ls') + '\n')
    const stamp = new Date(Date.now() - 5000)
    utimesSync(file, stamp, stamp)
    reader.read(agent)
    reader.retain([])
    writeFileSync(file, bash('ps') + '\n')
    utimesSync(file, stamp, stamp)
    expect(reader.read(agent)).toBe('Run: ps')
  })
})
