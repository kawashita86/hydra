import { lstatSync } from 'fs'
import type { ProviderId } from '@shared/types'
import type { AgentDetails } from '@shared/overview/types'
import { detailsFromTail } from '@shared/overview/details'
import { discoverClaudeProjectsDirs } from '../sessions/claudeProfiles'
import { locateClaudeTranscript, readTranscriptTail } from './waitingText'

export interface DetailsLocator {
  provider: ProviderId
  sessionId: string | null
  projectDir: string
  /** Claude config dir of the matched profile; its `projects/` is searched first. */
  configDir?: string
}

const UNSUPPORTED: AgentDetails = {
  lastMessage: { unavailable: 'not supported for this provider' },
  tokens: null
}

/**
 * Reads the details drawer data (last message, tokens of the newest reply)
 * from the last 256 KB of a Claude transcript. On demand only, never in polls.
 */
export class AgentDetailsReader {
  private readonly known = new Map<string, string>()

  constructor(private readonly projectsDirs: () => string[] = () => discoverClaudeProjectsDirs()) {}

  read(locator: DetailsLocator): AgentDetails {
    if (locator.provider !== 'claude') return UNSUPPORTED
    if (!locator.sessionId) {
      return { lastMessage: { unavailable: 'The session has no transcript yet' }, tokens: null }
    }
    try {
      const path = locateClaudeTranscript(
        locator.sessionId,
        locator.configDir,
        this.projectsDirs,
        this.known.get(locator.sessionId)
      )
      if (!path) {
        return { lastMessage: { unavailable: 'The transcript was not found' }, tokens: null }
      }
      this.known.set(locator.sessionId, path)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { lastMessage: { unavailable: 'The transcript could not be read' }, tokens: null }
      }
      const tail = readTranscriptTail(path)
      if (!tail) return { lastMessage: { unavailable: 'The transcript could not be read' }, tokens: null }
      return detailsFromTail(tail.text, tail.wholeFile)
    } catch {
      return { lastMessage: { unavailable: 'The transcript could not be read' }, tokens: null }
    }
  }
}
