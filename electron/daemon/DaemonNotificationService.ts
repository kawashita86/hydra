import { randomUUID } from 'crypto'
import type { AgentManager } from '../agents/AgentManager'
import type { HeadlessOrchestrator } from '../headless/HeadlessOrchestrator'
import type { HydraNotification, NotificationType, AgentStatusPayload } from '@shared/types'
import type { OverviewEvent, OverviewSession, OverviewSnapshot } from '@shared/overview/types'

const MAX_RECENT = 50

type Subscriber = (notification: HydraNotification) => void

/** The slice of `OverviewTracker` the notification service needs. */
export interface OverviewNotificationSource {
  on(event: 'events', listener: (events: OverviewEvent[]) => void): unknown
  peekSnapshot(): OverviewSnapshot | null
  hasRegistryMatch(agentId: string): boolean
}

function needsYouBody(session: Pick<OverviewSession, 'name' | 'waitingReason' | 'waitingText'>): string {
  const { name, waitingReason, waitingText } = session
  const detail = waitingText ? `: ${waitingText}` : ''
  switch (waitingReason) {
    case 'permission':
      return `${name} needs permission${detail}`
    case 'question':
      return waitingText ? `${name} asked a question: ${waitingText}` : `${name} asked a question`
    default:
      return `${name} is waiting for you${detail}`
  }
}

/**
 * Base notification service with no Electron dependencies.
 * Used directly by the daemon process. Extended by NotificationService
 * in Electron to add native OS notifications + IPC broadcasts.
 */
export class DaemonNotificationService {
  protected recent: HydraNotification[] = []
  protected subscribers = new Set<Subscriber>()
  private lastAgentStatus = new Map<string, string>()
  private overviewSource: OverviewNotificationSource | null = null

  /**
   * Notifies when a Claude agent enters `needs-you` per the Overview tracker,
   * with the reason. Once connected, the 5 s-silence `agent_waiting`
   * heuristic is suppressed for Claude agents the tracker matched to a
   * registry entry (it fires falsely for busy-but-quiet agents).
   */
  connectOverviewEvents(tracker: OverviewNotificationSource): void {
    this.overviewSource = tracker
    tracker.on('events', (events) => {
      for (const event of events) {
        if (event.kind !== 'status' || event.to !== 'needs-you') continue
        const session = tracker.peekSnapshot()?.sessions.find((s) => s.agentId === event.agentId)
        this.push({
          id: randomUUID().slice(0, 12),
          type: 'agent_waiting',
          title: 'Needs you',
          body: needsYouBody({
            name: session?.name ?? event.name,
            waitingReason: session?.waitingReason ?? event.waitingReason,
            waitingText: session?.waitingText
          }),
          agentId: event.agentId,
          timestamp: new Date().toISOString()
        })
      }
    })
  }

  push(notification: HydraNotification): void {
    this.recent.push(notification)
    if (this.recent.length > MAX_RECENT) {
      this.recent = this.recent.slice(-MAX_RECENT)
    }

    for (const sub of this.subscribers) {
      try {
        sub(notification)
      } catch {
        // Best-effort delivery
      }
    }
  }

  getRecent(limit = MAX_RECENT): HydraNotification[] {
    const count = Math.min(limit, this.recent.length)
    return this.recent.slice(-count)
  }

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  connectAgentEvents(
    agentManager: AgentManager,
    headlessOrchestrator: HeadlessOrchestrator
  ): void {
    agentManager.on('agent_waiting', (payload: { agentId: string }) => {
      const agent = agentManager.get(payload.agentId)
      const agentName = agent?.name ?? payload.agentId

      if (agent?.provider === 'claude' && this.overviewSource?.hasRegistryMatch(payload.agentId)) return

      this.push({
        id: randomUUID().slice(0, 12),
        type: 'agent_waiting',
        title: 'Agent Finished',
        body: `${agentName} is waiting for input`,
        agentId: payload.agentId,
        timestamp: new Date().toISOString()
      })
    })

    agentManager.on('status', (payload: AgentStatusPayload) => {
      const prev = this.lastAgentStatus.get(payload.agentId)
      if (prev === payload.status) return
      this.lastAgentStatus.set(payload.agentId, payload.status)

      const agent = agentManager.get(payload.agentId)
      const agentName = agent?.name ?? payload.agentId

      let type: NotificationType | null = null
      let title = ''
      let body = ''

      switch (payload.status) {
        case 'idle':
          type = 'agent_idle'
          title = 'Agent Completed'
          body = `${agentName} has finished`
          break
        case 'errored':
          type = 'agent_errored'
          title = 'Agent Error'
          body = `${agentName} encountered an error`
          break
        case 'running':
          type = 'agent_started'
          title = 'Agent Started'
          body = `${agentName} is now running`
          break
        default:
          return
      }

      this.push({
        id: randomUUID().slice(0, 12),
        type,
        title,
        body,
        agentId: payload.agentId,
        timestamp: new Date().toISOString()
      })
    })

    headlessOrchestrator.on('event', (payload: { runId: string; data: string }) => {
      const run = headlessOrchestrator.get(payload.runId)
      if (!run) return

      let type: NotificationType | null = null
      let title = ''
      let body = ''

      if (run.status === 'completed') {
        type = 'headless_completed'
        title = 'Headless Run Completed'
        body = `Run ${run.id} finished successfully`
      } else if (run.status === 'errored') {
        type = 'headless_errored'
        title = 'Headless Run Error'
        body = `Run ${run.id} failed: ${run.error ?? 'unknown error'}`
      } else {
        return
      }

      this.push({
        id: randomUUID().slice(0, 12),
        type,
        title,
        body,
        runId: run.id,
        timestamp: new Date().toISOString()
      })
    })
  }
}
