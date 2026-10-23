# Overview: correct times for ended sessions, "Not running" group

> Status: **PLANNED 2026-10-23** · Branch: `fix/overview-ended-sessions`
> Workflow: each step is implemented by a Sonnet 5.5 subagent, then reviewed and committed.

## Progress

Tick a step when it is merged into the feature branch, with tests passing (`npm run typecheck && npm test`).

- [x] Step 1 — `endedAt` on agents, persisted
- [x] Step 2 — New `not-running` status, tracker with real `statusSince`, counts, history
- [x] Step 3 — Grouping: "Not running" group, ended newest first, cap + "Show more"
- [ ] Step 4 — UI: "ended 3h ago" / "last active 2d ago", exit code, counts row, details drawer
- [ ] Step 5 — Polish: AGENTLOG, manual check with `npm run dev`

---

## 0. The bug

Every Finished session shows the same duration, about the time since Hydra was opened.

- `SessionRow.tsx` shows `now - session.statusSince`.
- `OverviewTracker.poll()` sets `statusSince` from the in-memory map `tracked`: `previous?.status === derived.status ? previous.since : now`. The map is empty when the daemon starts, so on the first poll every agent gets `since = now`. No end time is recorded or persisted anywhere.
- `deriveStatus` maps the manager's `idle` (no PTY) to `finished`. Agents restored by `hydrateWorkspaceAgents` and imported by `importSessions` come back as `idle`, so every restored agent is listed as Finished even though it never ran in this session (`lastExitCode === null`).

## 1. Decisions taken (from the Q&A)

| Topic | Decision |
| --- | --- |
| Restored / imported agents never run this session | Separate **"Not running"** group, timed by last activity ("last active 2d ago"). Finished / Failed keeps only agents that exited during this daemon run. |
| Time format for ended sessions | Relative: **"ended 3h ago"**; past 24 h a clock/date ("ended yesterday 14:02", "ended Oct 21"). Exact time in a tooltip. |
| Size of the group | **Newest first**, show 10, "Show N more" expands. |
| Persistence | **Persist `endedAt`** with the workspace agents, so the time survives restarts. |
| Model | **New `OverviewStatus` `'not-running'`** (not a flag on `finished`), so Timeline, legend, counts and events tell them apart. |

## 2. Design

### Data

- `AgentState.endedAt: string | null` (ISO, same as `startedAt`). Set in `pty.onExit` and on spawn failure; cleared when a PTY spawns. Persisted in `PersistedWorkspaceAgent.endedAt?`, restored by `hydrateWorkspaceAgents`.
- Shutdown: `daemon/index.ts` saves the workspace **before** `killAll()`, so agents running at shutdown would have no `endedAt`. Set `endedAt = now` on running agents just before that save (a small `AgentManager.markEnded()` or done inside `exportWorkspaceAgents({ endingNow: true })`).
- Imported sessions: `endedAt` and `lastActivityAt` from `ClaudeSessionSummary.modifiedAt` (today `lastActivityAt` uses `createdAt`, which is wrong for a "last active" time).

### Tracker (`electron/overview/OverviewTracker.ts`)

- New `OverviewStatus` **`'not-running'`**. `deriveStatus(agent, activity, …)`: manager status `idle` with `activity.lastExitCode === null` (no PTY exit seen in this daemon run: restored or imported, never started) → `not-running`; `idle` with an exit code → `finished` as today. `spawn` resets `lastExitCode` to `null` but the status then moves to `starting`/`running`, so an agent never goes back to `not-running`.
- `OverviewSession.endedAt?: number` (epoch ms), from `endedAt ?? lastActivityAt`, set for finished / failed / not-running. `OverviewSession.exitCode?: number` from `activity.lastExitCode`.
- `since` when the status changes or the agent is first seen: for `finished` / `failed` / `not-running`, `endedAt` (clamped to `≤ now`, falls back to `now`); otherwise `now` as today.
- `sessionKey` includes `endedAt` and `exitCode`.
- `computeCounts`: new `notRunning` count; `open` excludes `not-running` too.
- Everything keyed by `OverviewStatus`: `STATUS_LABEL` ("Not running"), `HistoryStore.STATUSES` (accept it when reading), `HistoryStore.diskStatuses` (not written to disk: nothing happens to such an agent), `historyFacts.toStatusText`, Timeline `LEGEND` (rows whose segments are only `not-running` are hidden), `Charts.module.css` `.s_not_running`, `Sessions.module.css` `.dot_not_running`, a `--color-status-not-running` token in each theme of `tokens.css` (muted grey, distinct from idle).

### Grouping (`shared/overview/grouping.ts`)

- List layout: groups Working, Idle, **Finished / Failed** (newest first: failed first, then by `statusSince` descending), **Not running** (newest first), Starting.
- `SessionGroup` gets `limit?: number`; ended and not-running groups use 10. `SessionsCard` renders the first `limit` rows and a "Show N more" / "Show less" button (state per group, not persisted).
- Board layout: "Finished / Failed" column newest first; not-running sessions left out of the board, with a line "N not running, in the list" under the column.
- Repos layout: not-running rows stay, sorted after Finished.

### UI

- `StatusFact`: working / idle / needs-you unchanged. Finished / failed: "ended 3h ago"; not-running: "last active 2d ago". Tooltip with the full date and time. A new `formatAgo(at, now)` in `format.ts` (relative up to 24 h, then "yesterday 14:02", then "Oct 21").
- Failed: "exit 1" after the label when the exit code is known (add `exitCode?: number` to `OverviewSession` from `activity.lastExitCode`).
- `CountsRow`: "6 open · 2 finished · 1 failed · 12 not running".
- `SessionDetails`: "Ended at 14:02 (3h ago)" for ended, "Last active …" for not-running.

## 3. Steps

### Step 1 — `endedAt` on agents, persisted
`shared/types.ts`, `electron/agents/AgentManager.ts`, `electron/workspace/WorkspaceStore.ts`, `electron/daemon/index.ts`. Tests: exit sets it, spawn clears it, hydrate restores it, export writes it, shutdown marks running agents, import uses `modifiedAt`.

### Step 2 — New `not-running` status, tracker, counts, history
`shared/overview/types.ts`, `status.ts`, `diff.ts` (if needed), `electron/overview/OverviewTracker.ts`, `HistoryStore.ts`, `historyFacts.ts`, `sessionFacts.ts`, `TimelineCard.tsx`, `CountsRow.tsx` (type only), CSS tokens/classes. Tests: first poll after start gives each restored agent `not-running` with its own `statusSince` from `endedAt`/`lastActivityAt`; an agent that exits during the run is `finished` with `since` = its `endedAt`; counts; history accepts and does not persist `not-running`.

### Step 3 — Grouping
`shared/overview/grouping.ts` + tests, `SessionsCard.tsx`, `SessionsBoard.tsx`.

### Step 4 — UI
`format.ts` (`formatAgo` + tests), `SessionRow.tsx`, `sessionFacts.ts`, `CountsRow.tsx`, `SessionDetails.tsx`, `Sessions.module.css`. Update the component tests.

### Step 5 — Polish
AGENTLOG entry (in-memory `statusSince` reset on daemon start; restored agents look "finished"). Check with `npm run dev`: restart Hydra, times should differ per agent and stay put.

## 4. Risks

- Agents saved before this change have no `endedAt`: fall back to `lastActivityAt`, which is updated on every PTY output, so it is close to the real end time.
- `HistoryStore` keeps its own `endedSince` for pruning points; it still uses the first point it sees. Fine for pruning, not changed.
- A daemon that keeps running while the window is closed keeps its in-memory times; nothing changes there.
