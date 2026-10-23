# Usage & limits — implementation plan

> Status: **APPROVED 2026-10-23** (mockups A and B approved), in progress · Branch: `feat/usage-limits`
> Workflow: each step is implemented by a Sonnet 5.5 subagent, then reviewed and committed.
> Reference project: [JingbiaoMei/Tokdash](https://github.com/JingbiaoMei/Tokdash) (MIT), its **native menu-bar companion** (`companion/`), not its web dashboard.
> Mockups: https://claude.ai/artifact/D49EVhNH8L73NFm8PxgmPV (A: header chip + popover, B: Overview card, C: states)

## Progress

Tick a step when it is merged into the feature branch, with tests passing (`npm run typecheck && npm test`).

- [x] Step 0 — Branch, plan, spike on the live limit endpoints
- [x] Step 1 — Usage model (pure, shared)
- [x] Step 2 — Claude transcript scanner
- [x] Step 3 — Codex rollout scanner (tokens + passive limits)
- [x] Step 4 — `UsageStore`: hourly buckets, file-offset cache, persisted
- [x] Step 5 — Claude plan limits (OAuth usage endpoint, per profile)
- [ ] Step 6 — `UsageService` in the daemon, REST + WS, IPC to the renderer
- [ ] Step 7 — Header chip + popover (mockup A)
- [ ] Step 8 — Overview "Usage & limits" card (mockup B)
- [ ] Step 9 — Low-limit alerts (opt-in) and Settings › Usage
- [ ] Step 10 — Move the old Usage dashboard onto the new data, retire ccusage (optional)
- [ ] Step 11 — Polish: states, docs, AGENTLOG

---

## 0. Decisions taken (from the Q&A)

| Topic | Decision |
| --- | --- |
| Placement | **A + B**: header chip with 5h / weekly meters opening a companion-style popover, **and** a "Usage & limits" card at the top of the Overview. No tray icon in v1 (C stays a later option). |
| Token data | **Native scanner** of Claude / Codex JSONL logs (incremental, cached), with **estimated "API-equivalent" cost** from a bundled price table. No ccusage needed. |
| Claude limits | **Live** through `/api/oauth/usage` per Claude profile, token read from `.credentials.json` / macOS Keychain, **never refreshed**. Low-limit alerts **opt-in, off by default**. |
| Scope v1 | **Claude + Codex**. OpenCode later. The existing Usage dashboard **stays** as "Detailed report" and moves onto the new data in Step 10. |

## 1. What we take from Tokdash (and what we leave)

Tokdash has two parts: a Python server with a large web dashboard, and a small native **companion** (SwiftUI `MenuBarExtra` / WPF tray flyout) that only reads the server's API. We copy the **companion's surface** (`companion/docs/IMPLEMENTATION_SPEC.md` §2), not the web UI.

| Companion part | What it shows | Hydra |
| --- | --- | --- |
| Header + freshness | Connected state, "Updated 2 min ago", refresh | Kept (no server here, so no connection state) |
| Period hero | `Day \| Week \| Month \| Year`: cost, tokens, messages, "▼ 12% vs yesterday" | Kept: `Today \| Week \| Month`. Week = calendar week from Monday, as Tokdash |
| Top tools / Top models | Top 3 by tokens | Becomes the **per-provider split** (Claude / Codex / OpenCode) + one "Top model" line |
| Activity glance | 24-hour histogram today, 7 columns for the week | Kept (today: hours, week: days, month: days) |
| Quota section `Low \| All` | Every plan window (5-hour, weekly, per-model weekly) with % and reset time; Low = only windows under their alert level | Kept as **Plan limits**, same Low/All filter |
| Low-quota notifications | Opt-in, once per crossing, deduplicated by provider/account/bucket/reset | Kept, through Hydra's existing notification path |
| Closed state | Menu-bar icon with tooltip | **Header chip** with two mini meters (5h / weekly); a real tray icon is an option (§7 Q1) |

**Left out**: the web dashboard, pricing editor, contribution heat-maps, sessions browser, multi-server, 25+ other tools (Kimi, Gemini, Cursor…), the reset-credit vouchers (`cedar_ember`), update checker.

## 2. Where the data comes from

### 2.1 Tokens per period, by provider (local logs, no network)

| Provider | Files | What we read |
| --- | --- | --- |
| Claude Code | `<profile>/projects/<folder>/<sessionId>.jsonl` for every profile (`discoverClaudeProjectsDirs()` already finds them) | `type: "assistant"` lines: `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, `message.model`, `timestamp`, `cwd`. **Dedupe by `message.id` + `requestId`** (Claude writes one line per content block with the same usage; ccusage does the same). Skip `model: "<synthetic>"`. |
| Codex | `$CODEX_HOME` or `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `event_msg` with `payload.type: "token_count"`: `info.last_token_usage` (per turn) or the delta of `info.total_token_usage`; model from `turn_context`. Codex `cached_input_tokens` is part of `input_tokens`, so subtract it once. |
| OpenCode | `~/.local/share/opencode/` (JSON files, newer versions SQLite) | Later step / out of v1 (not installed on this machine, two storage formats). |

Today the Usage dashboard shells out to `ccusage` / `npx @ccusage/codex` (`electron/ipc/handlers.ts:650`), up to 15 s per call, and fails when it is not installed. A native scanner is faster, works offline, needs nothing installed, and gives us hours (for the today histogram) and the provider split in one pass.

**Cost**: tokens are exact; dollars are an *estimate at API prices* (a subscription user pays a flat fee). Shown as "~$31.40 API-equivalent" with a bundled price table in `shared/usage/pricing.ts` (Claude + OpenAI models used by Codex); unknown models show tokens only. See §7 Q3.

### 2.2 Plan limits (5-hour session, weekly, weekly per model)

| Provider | Source | Notes |
| --- | --- | --- |
| Claude (Pro/Max sign-in) | `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20` | Same endpoint Claude Code's `/usage` uses, and Tokdash's `sources/quota/claude.py`. Token from `<profile>/.credentials.json` → `claudeAiOauth.accessToken` (Linux/Windows), or the macOS Keychain item `Claude Code-credentials` (`security find-generic-password -s … -w`). Response: newer `limits[]` (`kind`, `percent` 0-100, `resets_at`, `scope.model.display_name`), older `five_hour` / `seven_day` / `seven_day_opus` (`utilization`, `resets_at`). Parse both, every field optional. **Undocumented endpoint.** |
| Codex (ChatGPT sign-in) | Passive: the newest `token_count` event in the rollout logs carries `rate_limits.primary` / `secondary` (`used_percent`, `window_minutes`, `resets_at`) | No network, updates whenever a Codex agent runs. Marked **Estimated** with its age. Optional live read: `GET https://chatgpt.com/backend-api/wham/usage` with `~/.codex/auth.json` (later, if passive is not enough). |
| API-key users | — | No plan limits exist; the section says so and token usage still shows. |

Rules for the credentials (from Tokdash, they hold for us too):

- **Read only, never refresh.** Hydra never calls the OAuth refresh endpoint: refreshing rotates the refresh token and can sign Claude Code out. If `expiresAt` is past, or the API answers 401/403, show "Sign-in expired — start a Claude agent in this profile to refresh it" and keep the last values, dimmed.
- The token stays in the daemon. It is never logged, never sent over IPC/WS, never written to the usage cache, never passed to the Remote Control relay.
- One request per profile per poll, `timeout 15 s`, back off on 429/5xx (60 s → 2 min → 5 min → 10 min).
- Profiles: one row group per Claude profile Hydra knows (`useClaudeProfiles` / `claudeProfiles.ts`). Two profiles signed in to the same account (same JWT `sub`) are shown once.

Poll cadence: every **5 min** in the background, every **60 s** while the popover or the Overview card is visible, plus once after a Claude agent goes from working to idle (throttled to 60 s). Codex passive limits come for free from the scanner.

## 3. Placement

**A + B** (decided), sharing one data hook.

- **A · Header chip + popover** (primary). The `Usage` button in `Header.tsx` becomes a chip with two mini meters (most-used provider's 5h and weekly %, coloured green < 50 % ≤ amber < 80 % ≤ red). Click opens a ~390 px popover anchored under it, the companion's single surface: Plan limits (Low/All) → Tokens (Today/Week/Month, provider split, histogram) → footer (top model, "Detailed report" opens the existing dashboard). Escape / outside click closes. Visible from Grid, Chat and Overview.
- **B · Overview card**. A full-width "Usage & limits" card at the top of the Overview grid: four limit tiles left, per-period tokens with stacked daily bars right. New grid area `usage` in `OverviewView.module.css`.
- **C · System tray / menu-bar icon** (optional, later). Electron `Tray` with the same popover in a frameless window, so limits are visible with Hydra minimised. This is what Tokdash's companion literally is, but it is more platform work (Linux tray support varies).

## 4. Architecture

```
daemon process                                         electron main          renderer
──────────────                                         ─────────────          ────────
ClaudeTranscriptScanner (all profiles) ─┐
CodexRolloutScanner ($CODEX_HOME) ──────┼─► UsageStore (hourly buckets, offsets)
                                        │     └─ <userData>/usage-cache/v1.json
ClaudeLimitsClient (per profile) ───────┼─► UsageService (poll, back-off, alerts)
CodexPassiveLimits (from scanner) ──────┘     ├─ REST GET /usage/summary?period=…&from=…&to=…
                                              │      GET /usage/limits
                                              │      POST /usage/refresh
                                              └─ WS   usage:limits, usage:summary ─► IPC ─► useUsage()
                                                                                              ├─ UsageChip + UsagePopover
                                                                                              └─ UsageCard (Overview)
```

- Lives in the **daemon**, next to `OverviewTracker`: scanning GBs of JSONL must not block Electron main, and alerts keep working with the window closed (same reasoning as the Overview plan §4).
- **Buckets**: per `(UTC hour, provider, model, projectKey)` → `{input, output, cacheWrite, cacheRead, messages}`. Hours let the renderer build Today/Week/Month in the **local time zone** and the today histogram from one structure. Kept 400 days; older hours fold into days.
- **Incremental scan**: per file `{size, mtimeMs, offset, lastMessageKeys}`; on each pass only bytes after `offset` are read (complete lines only). A file that shrank or changed identity is re-read. First run on a big history happens in the background with progress ("Indexing usage… 40 %").
- Files are opened the way `historyFiles.ts` does (`O_NOFOLLOW`, regular files only, size cap per line) and parsing never throws.
- Pure logic (parsers, dedupe, period windows, deltas, limit classification, alert crossing) in `shared/usage/` so it is unit-tested without Electron, like `shared/overview/`.

### New / changed files

```
shared/usage/types.ts               UsageBucket, UsageSummary, ProviderUsage, LimitWindow, LimitsSnapshot, UsagePeriod
shared/usage/periods.ts             periodRange('today'|'week'|'month', now, tz), previousRange(), compare()
shared/usage/claudeLine.ts          parseClaudeUsageLine() + message dedupe key
shared/usage/codexLine.ts           parseCodexTokenCount() (tokens + rate_limits)
shared/usage/limits.ts              parseClaudeOAuthUsage() (limits[] and legacy shape), classify windows, severity()
shared/usage/pricing.ts             price table + estimateCost()
shared/usage/alerts.ts              crossing detection + dedupe key (provider, account, window, resetsAt, threshold)
electron/usage/scanFiles.ts         safe incremental reader (shares rules with overview/historyFiles.ts)
electron/usage/UsageStore.ts        buckets, offsets, persistence, pruning
electron/usage/claudeCredentials.ts read token per profile (file / macOS Keychain), never refresh
electron/usage/ClaudeLimitsClient.ts fetch + back-off
electron/usage/UsageService.ts      scheduler, snapshots, events
electron/daemon/{index,DaemonServer,protocol,DaemonClient}.ts   routes + WS messages
electron/ipc/handlers.ts, electron/preload.ts, shared/types.ts   IPC names (USAGE_SUMMARY_GET, USAGE_LIMITS_GET, USAGE_REFRESH, USAGE_EVENT)
src/hooks/useUsage.ts               one subscription owned by App (like useOverviewSnapshot)
src/components/Usage/UsageChip.tsx, UsagePopover.tsx, LimitRows.tsx, TokensPanel.tsx, HourBars.tsx
src/components/Overview/UsageCard.tsx
src/components/Header/Header.tsx    Usage button → UsageChip
src/components/Settings/…           Usage section: thresholds, alerts on/off, chip provider, cost on/off
```

---

## 5. Steps

Each step ends green on `npm run typecheck && npm test` and is one or a few Conventional Commits on `feat/usage-limits`. UI steps are checked with `npm run dev`.

### Step 0 — Branch, plan, spike
- `git checkout -b feat/usage-limits`, commit this file.
- Spike (no commit of secrets): call the Claude OAuth usage endpoint once with this machine's token and save the **shape** (values redacted) as a test fixture; confirm `limits[]` vs legacy fields and how `percent` is scaled (Tokdash found `1` = 1 %, not 100 %). On macOS, confirm the Keychain service name for non-default `CLAUDE_CONFIG_DIR` profiles.
- Collect one real Codex `token_count` line (redacted) as a fixture.

**Spike results (2026-10-23, Claude Code Pro sign-in, Linux):**
- `GET /api/oauth/usage` → 200. Body has both shapes: `limits[]` = `{kind: 'session' | 'weekly_all' | …, group, percent (integer 0-100), severity: 'normal' | …, resets_at (ISO), scope: null | {model: {display_name}}, is_active}` **and** legacy `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` = `{utilization (0-100), resets_at}` or `null`, plus `extra_usage`, `spend` and many `null` code-named keys. Prefer `limits[]`, fall back to the legacy keys. Saved redacted as `shared/usage/fixtures/claude-oauth-usage.json`.
- `.credentials.json` → `claudeAiOauth.{accessToken, refreshToken, expiresAt (ms), refreshTokenExpiresAt, scopes, subscriptionType ('pro' | 'max' | …), rateLimitTier}`. The access token lives ~8 h.
- Transcript `assistant` lines: `message.{id, model, usage}`, top-level `requestId`, `timestamp`, `cwd`, `sessionId`, `isSidechain`. `usage` = `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, plus `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` (1 h cache writes cost 2× input, 5 m cost 1.25×) and `output_tokens_details.thinking_tokens` (already inside `output_tokens`).
- Subagent transcripts live at `<profile>/projects/<folder>/<sessionId>/subagents/agent-*.jsonl` — the scanner must recurse. This machine: 3 profiles (`~/.claude`, `~/.claude-alternative`, `~/.claude-work`), 672 files; `~/.claude` alone 134 files, 387 MB. First full scan 2.7 s, incremental rescan < 50 ms, cache 2.9 MB.
- Codex is not installed here; Codex fixtures follow Tokdash's test shapes (`tests/test_quota_codex.py`, `tests/test_codex_compaction_billing.py`): `event_msg` / `payload.type: 'token_count'`, `payload.info.{last_token_usage, total_token_usage}` = `{input_tokens (includes cached), cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`, `payload.rate_limits.{plan_type, primary, secondary}` = `{used_percent, window_minutes (300 / 10080), resets_at (ISO or epoch s)}` (older logs put `rate_limits` under `info`). Model from `turn_context.payload.model`. Files under `$CODEX_HOME/sessions/**` **and** `$CODEX_HOME/archived_sessions/`. Resumed threads replay earlier events with new timestamps: dedupe by session id + the `(total, last)` usage signature.

### Step 1 — Usage model (pure, shared)
- `shared/usage/types.ts`, `periods.ts` (calendar week from local Monday, month from the 1st, previous equal window for the "vs" line), `pricing.ts`.
- Tests: period edges around midnight and DST, week starting Monday, comparison when the previous window is empty (omit the line).

### Step 2 — Claude transcript scanner
- `shared/usage/claudeLine.ts`: parse one line, return `{ ts, model, projectKey, tokens, dedupeKey }` or `null`; never throws.
- Dedupe across files of the same session (resumed/forked sessions copy earlier lines).
- Tests with fixtures: multi-block messages counted once, synthetic model skipped, missing fields, malformed JSON, cache fields.

### Step 3 — Codex rollout scanner
- `shared/usage/codexLine.ts`: tokens from `last_token_usage`, falling back to the delta of `total_token_usage`; cached input not double-counted; model from the latest `turn_context`.
- Same pass returns the newest `rate_limits` with its timestamp → passive Codex limits; window class from `window_minutes` (300 → 5-hour, 10080 → weekly; Tokdash `codex_quota_windows.py`).
- Tests: compaction/resume lines, missing `rate_limits`, single-window responses.

### Step 4 — `UsageStore`
- Hourly buckets, file offsets, persisted to `<userData>/usage-cache/v1.json` (folder 700, file 600, atomic write via temp + rename), versioned so a format change triggers one full rescan.
- `summary(range, tz)` → totals, per provider, per model, per project, hourly/daily series, previous-window totals.
- Tests: incremental append, truncated last line, file replaced, prune, restore from disk.

### Step 5 — Claude plan limits
- `claudeCredentials.ts`: per profile, `.credentials.json` first, Keychain on macOS; return `{ token, expiresAt, plan }` or a reason (`not-signed-in`, `api-key`, `expired`). Never refresh, never log.
- `ClaudeLimitsClient.ts`: fetch, parse with `shared/usage/limits.ts`, back-off, last-good kept per profile.
- Tests: both response shapes, percent scaling, 401 → expired, 429 back-off, duplicate accounts merged.

### Step 6 — `UsageService` in the daemon, IPC
- Scheduler (5 min / 60 s while visible / after agent idle), `POST /usage/refresh` coalesced.
- Renderer tells main when a usage surface is visible (`USAGE_VISIBILITY`) so the faster cadence only runs then.
- WS `usage:limits` on change; summaries fetched on demand.
- Tests: scheduling with fake timers, coalescing, token never present in any payload.

### Step 7 — Header chip + popover (mockup A)
- `UsageChip` replaces the `Usage` button; plain "Usage" when no limits are known.
- `UsagePopover`: Plan limits (Low/All, grouped by provider/profile), Tokens (Today/Week/Month), histogram, footer with "Detailed report".
- Keyboard: chip is a button with `aria-expanded`, Escape closes, focus returns to the chip.
- Tests: rendering of every state in mockup C, Low filter, severity colours, dimmed stale values.

### Step 8 — Overview "Usage & limits" card (mockup B)
- New `usage` grid area at the top; tiles + stacked daily bars; same `useUsage()` data, no second subscription.
- Respects the Overview project filter for tokens (limits are account-wide, the card says so).

### Step 9 — Alerts and Settings › Usage
- Opt-in alert (default off): session ≥ 80 % used, weekly ≥ 90 % used (configurable). Fires once per crossing, re-armed by a new `resets_at`. Sent by the daemon through the existing `notification` WS → `NotificationService.push`.
- Settings: thresholds, alerts, which provider the chip shows (auto = the most-used), show estimated cost on/off.

### Step 10 — Old Usage dashboard on the new data (optional)
- `UsageDashboard` reads `UsageStore` summaries instead of ccusage; drop `USAGE_DASHBOARD_GET` and the ccusage install screen.

### Step 11 — Polish
- Empty, loading, first-index progress, expired, API-key, estimated states (mockup C). README section, AGENTLOG entries (endpoint gotchas, never-refresh rule).

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| The Claude OAuth usage endpoint is undocumented and may change or rate-limit | Parse both known shapes, every field optional; back-off; limits section degrades to "unavailable", tokens keep working |
| macOS Keychain prompt ("Hydra wants to access…") the first time | Only read after the user turns plan limits on, or on first open of the popover with an explanation line; remember a denial |
| First scan of a large history is slow | Background, incremental, persisted offsets; UI shows progress and partial totals |
| Cost estimates drift from real prices | Labelled "API-equivalent", price table versioned, can be hidden |
| Codex passive limits are stale when no Codex agent ran recently | "Estimated · 3 h ago" badge; optional live endpoint later |

## 7. Later (not in v1)

- OpenCode provider (JSON + SQLite storage).
- System tray / menu-bar icon (mockup option C).
- Live Codex limits via `chatgpt.com/backend-api/wham/usage`, if the passive values are too stale.
