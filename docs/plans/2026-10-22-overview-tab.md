# Overview tab — implementation plan

> Status: **APPROVED 2026-10-22**, in progress · Branch: `feat/overview-tab`
> Workflow: each step is implemented by a Sonnet 5.5 subagent, then reviewed and committed.
> Reference project: [Olanetsoft/agent-lookout](https://github.com/Olanetsoft/agent-lookout) (MIT, © 2026 Idris Olubisi), its **Overview** view.

## Progress

Tick a step when it is merged into the feature branch, with tests passing (`npm run typecheck && npm test`).

- [x] Step 0 — Branch and plan
- [x] Step 1 — Overview status model (pure, shared)
- [x] Step 2 — Claude Code session registry reader
- [x] Step 3 — `OverviewTracker` in the daemon, and IPC down to the renderer
- [x] Step 4 — Third view: Grid | Chat | Overview
- [x] Step 5 — Needs you panel, counts and Jump
- [x] Step 6 — What a waiting session asks (transcript tail)
- [x] Step 7 — Sessions card: List, Repos, Board and details drawer
- [x] Step 8 — History: events and samples, kept on disk
- [x] Step 9 — Last hour chart and Timeline
- [x] Step 10 — Events log
- [ ] Step 11 — Waits (Waited on you bars, today / 7 days)
- [ ] Step 12 — Polish: badges, notifications, docs

---

## 1. Decisions taken (from the Q&A)

| Topic     | Decision                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope     | **Only agents spawned by Hydra.** No machine-wide discovery of external sessions.                                                                                                 |
| Placement | **A third main view**: the header switcher becomes `Grid \| Chat \| Overview` (`ViewMode` gains `'overview'`).                                                                   |
| Sections  | All four groups: **Needs you + counts**, **Sessions list/board**, **Last hour + Timeline**, **Events + Waits history** (history kept on disk).                                    |
| Projects  | **All projects**, with a project filter at the top of the Overview (default "All").                                                                                             |
| Answering | **Jump only in v1.** A waiting session has a Jump button that selects the agent and switches to Chat, so the prompt is answered in its terminal. No Allow/Deny from the Overview. |

## 2. What agent-lookout's Overview is (the bits we copy)

From `docs/GUIDE.md` › Overview and `src/dashboard/components/`:

| agent-lookout part                                                    | What it shows                                                                                                                                                         | Source in agent-lookout                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Needs you** panel                                                   | Sessions waiting on the user, longest first: name, reason (permission / question / other), folder, branch, agent, what it asks (`Run: npm test`), live timer, Jump. | `hero/HeroPanel.tsx`                                    |
| **Waited on you** bars                                                | One bar per session that waited in the last hour; open wait = filled amber, growing; answered = outlined.                                                             | `hero/WaitedOnYou.tsx`                                  |
| **Counts**                                                            | Working (+ longest busy), Idle (+ longest idle), Stale (idle ≥ 24 h), Sessions (open / finished / failed). Click → small history chart.                               | `hero/CountsRow.tsx`                                    |
| **Last hour**                                                         | 12 bars of 5 min: average needs-you / working / idle; hatched = not measured.                                                                                        | `last-hour/LastHourCard.tsx`, `ui/charts/HistoryChart` |
| **Sessions**                                                          | List grouped Working → Idle (stale marked) → Finished/Failed → Unknown; switch List / Repos / Board; "quiet for 12m"; click → details.                               | `sessions/SessionsCard.tsx`, `SessionsBoard.tsx`        |
| **Details**                                                           | Status + since, agent, folder, repo/branch, start time, PID, tokens of newest reply, waits count/total, last message, own events, own timeline row.                   | `panels/SessionPanel.tsx`, `LastMessage.tsx`            |
| **Events**                                                            | Appeared / status changed / ended, newest first; wait durations; "New since 14:02" marker.                                                                            | `events/EventsCard.tsx`                                 |
| **Timeline**                                                          | One row per session, status over the last hour.                                                                                                                       | `timeline/TimelineCard.tsx`, `ui/charts/StatusTrack`   |
| **Waits**                                                             | Wait totals today and over 7 days, by-day bars, five longest waiters.                                                                                                 | `waits/WaitsCard.tsx`, `core/waits/waitTotals.ts`       |

Layout: Needs you + Last hour on the top row, Sessions + Events on the next, Timeline then Waits full width. One column when narrow.

**Not copied** (out of scope): Sources and Settings views, other-machine/SSH sessions, email/ntfy/pushover/webhooks, permission rules, Allow/Deny plugin, pull-request lookup via `gh`, MCP server, CLI, quiet hours.

## 3. How Hydra fits

What Hydra already has, and the gap:

- **Agents live in the daemon** (`electron/daemon/index.ts`), which owns every PTY through `AgentManager`. Electron's main process is a client (`DaemonClient`, HTTP + WebSocket over a Unix socket) and relays to the renderer over IPC (`electron/preload.ts` → `window.hydra`).
- `AgentState.status` is `'running' | 'idle' | 'errored' | 'starting'` — it describes the **process**, not what the agent is doing. `running` covers both "busy" and "sitting at the prompt".
- `AgentManager` already tracks `lastOutputAt` per agent and emits `agent_waiting` after `IDLE_DETECTION_MS = 5000` of silence (`electron/agents/AgentManager.ts:52`, `startActivityPolling`). That is our *working vs idle* signal for every provider.
- Hydra knows each Claude agent's `sessionId`, `projectDir`, `pid`, `worktreeBranch`, and its **Claude profile** (`claudeProfileResolver` → `CLAUDE_CONFIG_DIR`).
- Claude Code writes a live registry file per running process at `<claude config dir>/sessions/<pid>.json`. Checked on this machine (Claude Code 2.1.308): fields `pid, sessionId, cwd, startedAt, kind, status ('busy'|'waiting'|'idle'|'shell'), waitingFor, updatedAt, statusUpdatedAt, name…`. agent-lookout maps `busy → working`, `waiting → needs-you`, `idle → idle`, `shell → working`; `waitingFor: 'permission prompt' → permission`, `'input needed' → question`, else `other`. **This is the only reliable "needs you" signal**, and it is undocumented: every field must be optional and parsing must never throw.
- Transcripts: `electron/sessions/TranscriptReader.ts` + `discoverClaudeProjectsDirs()` already find `<profile>/projects/<folder>/<sessionId>.jsonl` across profiles (see AGENTLOG "Multiple Claude Code profiles").
- No chart library: `UsageDashboard` draws its own. We do the same with inline SVG — **no new dependencies**.

### Status model for a Hydra agent

```
OverviewStatus = 'needs-you' | 'working' | 'idle' | 'starting' | 'finished' | 'failed'
(+ derived flag: stale = idle for ≥ 24 h;  measurement: quietForMs)
```

| Agent state                                    | Claude (registry entry found)                       | Claude (no entry) / Codex / OpenCode             |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `starting`                                     | `starting`                                          | `starting`                                       |
| `running`                                      | registry status: `busy`/`shell` → working, `waiting` → **needs-you** (+ reason), `idle` → idle | output within the last 5 s → working, else idle |
| `idle` (process exited 0 / stopped by user)    | `finished`                                          | `finished`                                       |
| `errored`                                      | `failed`                                            | `failed`                                         |

- **Matching an agent to its registry file**: by `sessionId` first (Hydra captures it), then by `pid` being the PTY pid or a descendant of it (the PTY may be a login-shell wrapper, see `shellWrapper.ts`), then by `cwd === projectDir` with `startedAt` within a few seconds of the agent's `startedAt`.
- **Quiet for**: a `working` agent whose PTY has produced no output for ≥ 5 min. Hydra has this for *every* provider, unlike agent-lookout which cannot do it for Claude.
- **Known limitation**: Codex and OpenCode never reach `needs-you` (agent-lookout has the same limit for Codex). A Codex agent waiting on an approval looks idle after 5 s of silence. A later step could screen-scrape the PTY buffer for their approval prompts; not in v1.

## 4. Architecture

```
daemon process                                    electron main            renderer
──────────────                                    ─────────────            ────────
AgentManager ──(state, lastOutputAt, exit)──┐
ClaudeRegistryReader (<profile>/sessions) ──┼─► OverviewTracker (poll 2 s)
TranscriptTail (waiting text, on demand) ───┘     │ snapshot + diff → events
                                                  │ HistoryStore (5 s samples, events)
                                                  │   └─ JSONL in <userData>/overview-history
                                                  ├─ REST  GET /overview, /overview/history,
                                                  │        /overview/waits, /overview/agents/:id/details
                                                  └─ WS    overview:snapshot ──────► IPC ─────► useOverview()
                                                                                                 └─ OverviewView
```

- The tracker lives in the **daemon** next to `AgentManager`, so history keeps counting while the Electron window is closed and the daemon keeps running.
- Pure logic (status mapping, diffing, wait totals, chart bucketing, grouping) goes in `shared/overview/` so both sides and unit tests use it without Electron.

### New / changed files (overview)

```
shared/overview/types.ts              OverviewStatus, OverviewSession, OverviewSnapshot, OverviewEvent, HistoryPoint, WaitTotals
shared/overview/status.ts             deriveStatus(), mapClaudeRegistryStatus(), isStale()
shared/overview/diff.ts               diffSnapshots() → events
shared/overview/buckets.ts            lastHourBuckets(), timelineSegments()
shared/overview/waits.ts              waitTotals() (today / 7 days / longest waiters)
shared/overview/grouping.ts           groupByStatus(), groupByRepo(), boardColumns()
electron/overview/claudeRegistry.ts   read <profile>/sessions/*.json safely
electron/overview/waitingText.ts      port of agent-lookout lastAsk.ts (transcript tail → "Run: npm test")
electron/overview/OverviewTracker.ts  poll loop, snapshot, events, emits 'snapshot'
electron/overview/HistoryStore.ts     ring buffers + JSONL persistence + pruning
electron/agents/AgentManager.ts       + getActivity(agentId): { lastOutputAt, exitCode }
electron/daemon/{index,DaemonServer,protocol,DaemonClient}.ts   wire routes + WS message
electron/ipc/handlers.ts, electron/preload.ts, shared/types.ts (IPC names)
src/hooks/useOverview.ts
src/components/Overview/…            one component per card, CSS modules
src/hooks/useViewMode.ts, src/components/Header/ViewSwitcher.tsx, src/App.tsx
```

Code ported from agent-lookout keeps a header comment: `// Adapted from agent-lookout (MIT, © 2026 Idris Olubisi): <path>`.

---

## 5. Steps

Each step ends green on `npm run typecheck && npm test`, and is one or a few Conventional Commits on `feat/overview-tab`. UI steps are checked with `npm run dev`.

### Step 0 — Branch and plan
- `git checkout -b feat/overview-tab`, commit this file.

### Step 1 — Overview status model (pure, shared)
- `shared/overview/types.ts`: the types above. `OverviewSession` = `{ agentId, name, provider, model, projectDir, worktreeBranch, status, statusSince, waitingReason?, waitingText?, quietForMs?, stale, pid, startedAt, lastOutputAt }`.
- `shared/overview/status.ts`: `mapClaudeRegistryStatus(fields)` (port of `claudeCodeMapping.ts`, unknown → `null`, never throws) and `deriveStatus(agentState, activity, registryEntry | null, now)` per the table in §3.
- `statusSince`: kept by the tracker (time the derived status last changed), not derivable here.
- **Tests**: every row of the mapping table; unknown registry values; stale boundary; quiet-for boundary.

### Step 2 — Claude Code session registry reader
- `electron/overview/claudeRegistry.ts`: `readClaudeRegistry(configDirs: string[]): RegistryEntry[]`.
  - For each profile dir (reuse the discovery from `electron/sessions/claudeProfiles.ts`), list `sessions/`, read only `*.json` regular files (no symlinks; skip `.key` files), cap size (e.g. 64 KB), `JSON.parse` in try/catch, keep only the known fields.
  - Keep the last good parse per file for one poll, so a half-written file doesn't flicker (agent-lookout does this).
  - Drop entries whose `pid` is dead (`process.kill(pid, 0)`).
- `matchRegistryEntry(agent, entries, descendantPids)` with the three-tier matching from §3. Descendant pids: `ps -A -o pid=,ppid=` on macOS/Linux at most every 10 s, only when an agent has no sessionId match; skip on Windows.
- **Tests**: temp dir fixtures (good file, malformed, symlink, `.key`, dead pid, two profiles); matching tiers.

### Step 3 — `OverviewTracker` in the daemon, and IPC
- `AgentManager.getActivity(agentId)` → `{ lastOutputAt, lastExitCode }` (store exit code in `onExit`).
- `OverviewTracker` (EventEmitter): `start()` polls every 2 s; builds `OverviewSnapshot = { at, sessions[], counts }`; keeps `statusSince` per agent; emits `snapshot` only when something changed (and at least every 10 s for timers' sake — or let the renderer tick timers itself, preferred).
- Also listen to `AgentManager` `'status'` events to re-poll immediately (spawn / exit feel instant).
- Daemon: construct in `electron/daemon/index.ts`; `GET /overview` in `DaemonServer`; WS `{ type: 'overview:snapshot', payload }` in `protocol.ts`; relay in `DaemonClient` → main → `IPC.OVERVIEW_SNAPSHOT`; preload `getOverview()` and `onOverviewSnapshot(cb)`.
- **Tests**: tracker with a fake AgentManager + fake registry + fake clock: status transitions, `statusSince`, emits on change only. Extend `DaemonClient.test.ts` for the new message.

### Step 4 — Third view: Grid | Chat | Overview
- `ViewMode = 'grid' | 'chat' | 'overview'` in `shared/types.ts`.
- `useViewMode`: `toggleViewMode` keeps flipping Grid ↔ Chat (existing shortcut unchanged); add `setViewMode('overview')`.
- `ViewSwitcher`: three tabs, each calling `setViewMode` directly (today both buttons call `onToggle`). Header prop changes accordingly.
- `App.tsx`: `safeViewMode` in `readWorkspaceUiState` (line ~67) must accept `'overview'`; render `<OverviewView>` when selected; the editor overlay and per-project header bits stay chat/grid-only.
- Keybinding `mod+shift+o` (command `show-overview`) → Overview.
- `useOverview()` hook: initial `getOverview()` + subscription; local 1 s ticker for timers.
- `OverviewView` skeleton: responsive CSS grid with the six card slots, empty states.
- **Decided**: the Overview shows **all projects**, with a project filter at the top (default "All"). The Grid already covers per-project.
- **Tests**: `App.flow.test.tsx` — switching to Overview and back, persisted view mode restored.

### Step 5 — Needs you panel, counts and Jump
- `NeedsYouPanel`: longest wait first; name, reason (`waiting for permission` / `asked you a question` / `waiting for you`), `project on branch · provider`, live timer, **Jump**.
- **Jump** = select the project + agent and `setViewMode('chat')` (reuse what the sidebar does on agent click). Also offered in the list rows and board cards.
- Empty state: "Nothing needs you" + the last wait that ended in the last hour (needs events → shows "—" until Step 8 lands, then wired).
- `CountsRow`: Working (+ longest), Idle (+ longest), Stale, Agents (open / finished / failed). Click-to-chart comes with Step 9.
- **Tests**: ordering, reason labels, Jump callback (React Testing Library).

### Step 6 — What a waiting session asks
- `electron/overview/waitingText.ts`: port `transcript/lastAsk.ts` + `waitingText()` from `core/text.ts`: read the last 256 KB of the transcript, skip the first partial line, skip `isSidechain`, find the newest assistant `tool_use` with no matching `tool_result` → one line: `Run: <cmd first line>`, `Edit:/Write:/Read: <relative path>`, `Fetch: <url>`, `Search: <q>`, `Approve the plan` (ExitPlanMode), first question for `AskUserQuestion`, `Use: <tool>`; cut to 200 chars.
- Only for agents in `needs-you`; cache per agent keyed on file size + mtime; drop the cache when the agent stops waiting.
- Transcript path: reuse `findTranscriptFile()` logic from `TranscriptReader.ts` (respects profiles).
- **Tests**: transcript fixtures for each tool kind, unanswered vs answered, sidechain lines, truncated tail.

### Step 7 — Sessions card: List, Repos, Board and details
- `SessionsCard` with a segmented control List / Repos / Board (choice kept in `localStorage`, like other UI prefs).
  - **List**: groups Working → Idle (stale marked) → Finished/Failed; columns name, provider/model, folder + branch, status + duration, `quiet for 12m`. Narrow window drops columns progressively.
  - **Repos**: group by repository root (a worktree groups under its main repo). Use `GitService` / read `.git` + `commondir` to find the root; cache per projectDir.
  - **Board**: columns Needs you / Working / Idle / Finished-failed, max 5 cards then "and N more".
- **Details drawer** (`SessionDetails`): status + since, provider/model, full path (copyable), repo/branch, started at, PID, waits count/total (Step 11), last message (reuse `TranscriptReader`, last assistant text, max 2000 chars, polled every 2 s while open), token counts of the newest reply (port `lastUsage.ts`; Claude only), its own events and timeline row (Steps 9–10). Buttons: Jump, Stop/Restart (existing agent actions).
- **Tests**: grouping functions (pure), board column caps, drawer open/close with Esc.

### Step 8 — History: events and samples on disk
- `HistoryStore` in the daemon:
  - **Events**: `appeared`, `status` (from → to, with wait duration when leaving needs-you), `ended`, `stopped-by-user`; ring of 1 000 in memory.
  - **Samples** every 5 s: `[at, needsYou, working, idle, total]` + per-agent status for the timeline; ring of 6 h (4 320 points) in memory.
  - Persist as JSONL under `<userData>/overview-history/v1-YYYY-MM-DD.jsonl` (`{"start":at}`, `{"point":[…]}`, `{"event":{…}}`); flush every 5 s and on shutdown; delete days older than 8 days and keep total ≤ 20 MB; folder mode 700, files 600. On start, restore the newest events/points before the first poll, and record a gap (`start` record) so charts hatch the unmeasured time.
  - Only one writer: the daemon is already single-instance (`daemon/lock.ts`), so no writer lock needed — note it in AGENTLOG.
- REST `GET /overview/history?since=` and events piggy-back on the snapshot WS message (new events only).
- **Tests**: in-memory fs fake; restore; pruning by age and size; malformed lines skipped.

### Step 9 — Last hour chart and Timeline
- `shared/overview/buckets.ts`: 12 five-minute buckets aligned to the clock, averages per status; unmeasured spans from gaps between samples > 15 s and from `start` records.
- `LastHourChart`: stacked SVG bars (needs-you amber at bottom, working above, idle as remainder), hatched pattern for unmeasured, hover / arrow-key tooltip, total-waited line above.
- `TimelineCard`: one SVG row per agent, colored segments per status, hatched gaps, legend.
- Count click → small 15 min / 1 h / 6 h chart for Working / Idle / Needs you (reuses the chart component).
- Colors from the existing theme CSS variables, checked in `light`, `dark` and `midnight`.
- **Tests**: bucketing and segment math (pure).

### Step 10 — Events log
- `EventsCard`: newest first, icon per kind, agent name, relative time, wait duration on needs-you exits, "watching resumed after X" rows for gaps, "Started watching" footer.
- "New since HH:MM" marker: remember when the Overview was last left/hidden (`document.visibilityState` + view switch), mark newer events, clear after 10 s in view.
- **Tests**: marker logic.

### Step 11 — Waits
- `shared/overview/waits.ts`: port of `waitTotals.ts` — a wait is entry into needs-you until the next exit; count only measured time; split by local day; today, 7 days, by-day bars, five longest waiters.
- `WaitedOnYou` bars in the Needs you panel (last hour; open = filled amber and growing, answered = outlined).
- `WaitsCard`: today / 7 days figures, by-day bars (hatched unmeasured days), longest waiters with a Today / 7 days switch.
- REST `GET /overview/waits`, fetched every 30 s and on any needs-you event.
- **Tests**: waits across a gap, across midnight, two agents at once, open wait.

### Step 12 — Polish
- Needs-you badge: count on the Overview tab in the switcher, and in the window title `(2) Hydra`.
- Notifications: when an agent enters `needs-you` from the registry, push `agent_waiting` with the reason ("needs permission: Run: npm test") — more accurate than today's 5-second silence heuristic. Keep the old heuristic for non-Claude providers.
- Hydra Remote (`hydra-remote/`) untouched in v1; note as follow-up.
- README section, AGENTLOG entries for gotchas found, update this plan's progress.

---

## 6. Risks and open points

- **Undocumented registry format.** `~/.claude/sessions/<pid>.json` may change between Claude Code versions. Mitigation: optional fields, unknown → fall back to output activity, a unit test fixture per known version. If the file disappears entirely, Claude agents degrade to working/idle only.
- **sessionId capture timing.** A brand-new Claude agent has no sessionId for a few seconds; the pid/cwd matching tiers cover it.
- **Shell wrapper PIDs.** With `login` shell mode the PTY pid is the shell, not `claude`; hence the descendant-pid tier.
- **Performance.** One `readdir` + a few small reads every 2 s per profile; transcript tail only for waiting agents and an open details drawer. `ps` at most every 10 s and only when needed.
- **Windows.** Registry reading works; descendant-pid matching is skipped, so matching relies on sessionId / cwd.
