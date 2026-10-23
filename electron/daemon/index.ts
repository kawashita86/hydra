/**
 * Hydra Daemon — standalone Node.js process that owns all PTY sessions.
 *
 * Usage: node daemon.js [--socket-path <path>] [--user-data <path>]
 *
 * The daemon serves HTTP + WebSocket on a Unix domain socket.
 * Hydra (Electron) connects as a client. If the daemon isn't running,
 * Electron spawns it automatically.
 */

import { join } from 'path'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { AgentManager } from '../agents/AgentManager'
import { ConfigStore } from '../config/ConfigStore'
import { SessionCatalog } from '../sessions/SessionCatalog'
import { createClaudeProfileResolver } from '../sessions/claudeProfiles'
import { CodexSessionCatalog } from '../sessions/CodexSessionCatalog'
import { HeadlessOrchestrator } from '../headless/HeadlessOrchestrator'
import { WorkspaceStore } from '../workspace/WorkspaceStore'
import { DaemonNotificationService } from './DaemonNotificationService'
import { DaemonServer } from './DaemonServer'
import { writeLockFile, removeLockFile } from './lock'
import { HydraMcpServer } from '../mcp/McpServer'
import { SkillScanner } from '../skills/SkillScanner'
import { getDefaultModelForProvider } from '@shared/types'
import type { OverviewEvent } from '@shared/overview/types'
import type { UsageState } from '@shared/usage/types'
import { OverviewTracker } from '../overview/OverviewTracker'
import { ClaudeRegistryReader } from '../overview/claudeRegistry'
import { ProcessTableReader } from '../overview/processTree'
import { WaitingTextReader } from '../overview/waitingText'
import { AgentDetailsReader } from '../overview/agentDetails'
import { GitInfoCache } from '../overview/gitInfo'
import { HistoryStore } from '../overview/HistoryStore'
import { discoverClaudeConfigDirs } from '../sessions/claudeProfiles'
import { UsageService } from '../usage/UsageService'
import { UsageAlerts } from '../usage/UsageAlerts'
import { UsageStore, defaultUsageSources } from '../usage/UsageStore'
import { ClaudeLimitsClient } from '../usage/ClaudeLimitsClient'
import { listClaudeProfiles } from '../sessions/claudeProfiles'
import { fixPath } from '../util/fix-path'

// ── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(): { socketPath: string; userDataPath: string; lockPath: string } {
  const args = process.argv.slice(2)
  let socketPath = ''
  let userDataPath = ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket-path' && args[i + 1]) {
      socketPath = args[++i]
    } else if (args[i] === '--user-data' && args[i + 1]) {
      userDataPath = args[++i]
    }
  }

  if (!userDataPath) {
    userDataPath = join(homedir(), '.config', 'Hydra')
  }

  if (!socketPath) {
    socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\hydra-daemon-${userDataPath.replace(/[^a-zA-Z0-9]/g, '_')}`
      : join(userDataPath, 'daemon.sock')
  }

  const lockPath = join(userDataPath, 'daemon.lock')

  return { socketPath, userDataPath, lockPath }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { socketPath, userDataPath, lockPath } = parseArgs()

  mkdirSync(userDataPath, { recursive: true })

  // Fix PATH before anything tries to resolve CLI tools
  fixPath()

  console.log(`[daemon] Starting — PID ${process.pid}`)
  console.log(`[daemon] platform: ${process.platform}`)
  console.log(`[daemon] userDataPath: ${userDataPath}`)
  console.log(`[daemon] socketPath:   ${socketPath}`)
  console.log(`[daemon] PATH: ${process.env.PATH}`)

  // ── Instantiate services ────────────────────────────────────────────────

  const configStore = new ConfigStore(userDataPath)
  const workspaceStore = new WorkspaceStore(userDataPath)
  const sessionCatalog = new SessionCatalog()
  const codexSessionCatalog = new CodexSessionCatalog()
  const agentManager = new AgentManager(sessionCatalog, codexSessionCatalog)
  agentManager.setShellConfigProvider(() => {
    const c = configStore.get()
    return {
      mode: c.terminalShellMode,
      path: c.terminalShellPath,
      args: c.terminalShellArgs
    }
  })
  const headlessOrchestrator = new HeadlessOrchestrator(join(userDataPath, 'headless-runs'))
  const claudeProfileResolver = createClaudeProfileResolver(
    sessionCatalog,
    () => configStore.get().claudeProfileByProject
  )
  agentManager.setClaudeProfileResolver(claudeProfileResolver)
  headlessOrchestrator.setClaudeProfileResolver(claudeProfileResolver)
  const notificationService = new DaemonNotificationService()

  // Restore workspace agents
  const config = configStore.get()
  const restored = agentManager.hydrateWorkspaceAgents(workspaceStore.getAgents())
  if (restored > 0) {
    console.log(`[daemon] Restored ${restored} workspace agents`)
  }

  // Import sessions — each catalog dictates its own provider, so sessions
  // are always resumed with the CLI that originally created them (never
  // stamped with the user's defaultProvider, which would cause resume failures).
  if (config.importSessionsOnStartup) {
    const listOptions = {
      limit: config.sessionImportLimit > 0 ? config.sessionImportLimit : undefined,
      projectPathPrefix: config.sessionImportProjectPrefix || undefined,
      hiddenSessionIds: config.hiddenSessionIds
    }

    try {
      const claudeSessions = sessionCatalog.listSessions(listOptions)
      const importedClaude = agentManager.importSessions(
        claudeSessions,
        getDefaultModelForProvider('claude'),
        'claude'
      )
      if (importedClaude > 0) {
        console.log(`[daemon] Imported ${importedClaude} Claude sessions`)
      }
    } catch (err) {
      console.warn('[daemon] Failed to import Claude sessions:', err)
    }

    try {
      const codexSessions = codexSessionCatalog.listSessions(listOptions)
      const importedCodex = agentManager.importSessions(
        codexSessions,
        getDefaultModelForProvider('codex'),
        'codex'
      )
      if (importedCodex > 0) {
        console.log(`[daemon] Imported ${importedCodex} Codex sessions`)
      }
    } catch (err) {
      console.warn('[daemon] Failed to import Codex sessions:', err)
    }
  }
  workspaceStore.setAgents(agentManager.exportWorkspaceAgents())

  // Connect notifications to agent events
  notificationService.connectAgentEvents(agentManager, headlessOrchestrator)

  // Start MCP server
  let mcpServer: HydraMcpServer | null = null
  try {
    mcpServer = new HydraMcpServer(agentManager, userDataPath)
    mcpServer.setNotificationService(notificationService)
    await mcpServer.start()
    const status = mcpServer.getStatus()
    console.log(`[daemon] MCP server listening on port ${status.port}`)
  } catch (err) {
    console.warn('[daemon] MCP server failed to start:', err)
    mcpServer = null
  }

  // ── Start HTTP+WS server ────────────────────────────────────────────────

  const shutdown = (): void => {
    console.log('[daemon] Shutting down...')
    workspaceStore.setAgents(agentManager.exportWorkspaceAgents({ endingNow: true }))
    agentManager.killAll()
    overviewTracker.stop()
    overviewHistory.stop() // flushes what is buffered
    usageService.stop() // flushes the usage cache
    mcpServer?.stop()
    server.stop()
    removeLockFile(lockPath)
    // Give processes time to clean up
    setTimeout(() => process.exit(0), 2000)
  }

  const skillScanner = new SkillScanner()

  // Single writer: this daemon is single-instance (see ./lock.ts), so the history folder needs no lock.
  const overviewHistory = new HistoryStore({ dir: join(userDataPath, 'overview-history') })
  overviewHistory.start()

  const overviewTracker = new OverviewTracker({
    history: overviewHistory,
    agentManager,
    registryReader: new ClaudeRegistryReader(),
    processTableReader: new ProcessTableReader(),
    configDirs: () => discoverClaudeConfigDirs(),
    waitingTextReader: new WaitingTextReader(),
    gitInfo: new GitInfoCache(),
    detailsReader: new AgentDetailsReader()
  })

  notificationService.connectOverviewEvents(overviewTracker)

  // Single writer for <userData>/usage-cache too (single-instance daemon).
  const usageService = new UsageService({
    store: new UsageStore({ dir: join(userDataPath, 'usage-cache'), sources: () => defaultUsageSources() }),
    limits: new ClaudeLimitsClient({
      profiles: () => listClaudeProfiles(),
      version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined
    })
  })

  // Opt-in low-limit notifications; the settings are read from the daemon's config on every evaluation.
  const usageAlerts = new UsageAlerts({
    dir: join(userDataPath, 'usage-cache'),
    settings: () => configStore.get().usage,
    notify: (n) => notificationService.push(n),
    runningAgents: (provider) =>
      overviewTracker
        .peekSnapshot()
        ?.sessions.filter((s) => s.provider === provider && (s.status === 'working' || s.status === 'needs-you')).length ?? 0
  })
  usageService.on('changed', (state: UsageState) => usageAlerts.evaluate(state))

  // A Claude agent that goes working -> idle has just written a transcript and moved the limits.
  // Events carry no provider, so it is looked up in the tracker's latest snapshot.
  overviewTracker.on('events', (events: OverviewEvent[]) => {
    const snapshot = overviewTracker.peekSnapshot()
    for (const e of events) {
      if (e.kind !== 'status' || e.from !== 'working' || e.to !== 'idle') continue
      if (snapshot?.sessions.find((s) => s.agentId === e.agentId)?.provider === 'claude') {
        usageService.notifyAgentIdle()
        break
      }
    }
  })

  const server = new DaemonServer({
    socketPath,
    agentManager,
    configStore,
    sessionCatalog,
    codexSessionCatalog,
    headlessOrchestrator,
    workspaceStore,
    notificationService,
    mcpServer,
    skillScanner,
    overviewTracker,
    overviewHistory,
    usageService,
    onConfigChanged: () => usageAlerts.evaluate(usageService.state()),
    onShutdown: shutdown
  })

  await server.start()
  overviewTracker.start()
  usageService.start()

  // Write lock file
  writeLockFile(lockPath, {
    pid: process.pid,
    socketPath,
    startedAt: new Date().toISOString()
  })

  console.log(`[daemon] Ready — lock file written to ${lockPath}`)

  // ── Signal handling ─────────────────────────────────────────────────────

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  process.on('uncaughtException', (err) => {
    console.error('[daemon] Uncaught exception:', err)
    shutdown()
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[daemon] Unhandled rejection:', reason)
  })
}

main().catch((err) => {
  console.error('[daemon] Fatal error during startup:', err)
  process.exit(1)
})
