# Phase 0 — Hook Surface Findings

**Probed:** 2026-07-12, Claude Code **2.1.207**, macOS (darwin)
**Method:** `probe/generate-settings.mjs` → per-event command-hook captures under `probe/captures/`, plus a live loopback HTTP listener (`probe/http-listener.mjs`). Six headless (`-p`) sessions, runs A–F.
**Plan reference:** `IMPLEMENTATION-PLAN.md` §5.

---

## 1. Verdicts

| Question (DESIGN ref) | Verdict |
|---|---|
| `--session-id`, `-n/--name`, `--settings`, `--permission-mode` exist (§16.3) | **YES**, all four |
| `--session-id <uuid>` → transcript at `~/.claude/projects/<slug>/<uuid>.jsonl` (§2.1 join contract) | **YES** — validated end-to-end, run A |
| `type: "http"` hooks accepted and actually POST (§16.4) | **YES** — POST received, JSON body identical to command-hook stdin, `Authorization: Bearer $VAR` interpolated via `allowedEnvVars`, 200 accepted |
| `MessageDisplay` exists (§16.7 warning) | **YES** — but payload differs from DESIGN's guess (see §3) |
| `UserPromptSubmit` carries `prompt_id` + `prompt` (§17.2 confirmation match) | **YES**, both |
| `PreToolUse`/`PostToolUse` carry `tool_use_id` (§14.4) | **YES**, plus `tool_response` and `duration_ms` on Post |
| Unknown event names in settings | **Silently tolerated** — no validation error, no capture. Registry may include speculative names safely |
| `PermissionRequest` fires headless when a tool is denied | **NO** — print-mode denial fires `PreToolUse` only, then nothing. Captured interactively instead (M1 done — see §3.1); it fires when the dialog is *shown*, before approve/deny |

**Go/no-go on HTTP hooks: GO.** Hybrid bridge per DESIGN §16.4 stands; the command-forwarder is fallback only.

---

## 2. Common envelope (observed on every event)

```
session_id        uuid (equals our --session-id)
transcript_path   absolute path to the session JSONL  ← handed to us; no path construction needed
cwd               session working directory
hook_event_name   the event name
```

Post-prompt events additionally carry `prompt_id` (uuid), and most carry `permission_mode`; tool/stop events carry `effort: { level }`.

**`prompt_id` is the native turn ID** — DESIGN's `turn.started { turnId }` maps directly. Note: `MessageDisplay` carries **both** `prompt_id` and a distinct `turn_id` (plus `message_id`) — there are two correlation levels (user prompt vs. assistant response cycle). Normalizer should preserve both.

---

## 3. Event census (headless runs A–F)

| Event | Fired | Notable payload fields beyond envelope |
|---|---|---|
| `SessionStart` | ✓ | `source: "startup"`, `session_title` (from `-n`) |
| `SessionEnd` | ✓ | `reason` (`"other"` observed), `prompt_id` |
| `UserPromptSubmit` | ✓ | `prompt`, `prompt_id`, `session_title`, `permission_mode` |
| `InstructionsLoaded` | ✓ | `file_path`, `memory_type` (`"User"`), `load_reason` (`"session_start"`) |
| `PreToolUse` | ✓ | `tool_name`, `tool_input`, `tool_use_id`, `prompt_id`, `permission_mode`, `effort` |
| `PostToolUse` | ✓ | ditto + `tool_response` (full result object), `duration_ms` |
| `MessageDisplay` | ✓ | **streaming**: `delta`, `index`, `final`, `turn_id`, `message_id` — not the single-`text` shape DESIGN §16.7 sketched |
| `Stop` | ✓ | `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]` |
| `PermissionRequest` | ✓ interactive (M1) | envelope + `prompt_id`, `permission_mode`, `effort`, `tool_name`, `tool_input`, `permission_suggestions[]`. **No `tool_use_id`** (see §3.1) |
| `PostToolUseFailure` | ✓ interactive (M1) | envelope + `tool_name`, `tool_input`, `tool_use_id`, `duration_ms`, `error` (string), `is_interrupt` (bool). Fires when an **approved** tool executes and fails (exit≠0) |
| `Notification` | ✓ interactive (M1) | `message`, `notification_type` (`"permission_prompt"` observed). Envelope + `prompt_id`; no `permission_mode`/`effort` |
| `SubagentStart` | ✓ interactive (M1) | envelope + `prompt_id`, `agent_id` (17-hex, **not** a uuid), `agent_type` (`"general-purpose"`) |
| `SubagentStop` | ✓ interactive (M1) | envelope + `agent_id`, `agent_type`, `agent_transcript_path` (subagent's own JSONL), `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]`. **Fires repeatedly** — 1× `stop_hook_active:false` then N× `true` |
| `TaskCreated`, `TaskCompleted` | ✗ | did **not** fire when the Task tool spawned a subagent (that path fires `Subagent*`). Distinct task system; needs a different trigger |
| `Task*`, `PreCompact/PostCompact`, others | not exercised | need targeted triggers |

Raw headless captures: `probe/captures/*.jsonl`. Raw interactive captures: `probe/captures-interactive/*.jsonl` (M1; multiple sessions appended, discriminate by `session_id`). Representative single lines seed `packages/testing/fixtures/hooks/` (13 events now: the 8 headless + `PermissionRequest`, `Notification`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`).

### 3.1 Interactive census (M1)

**Method:** `packages/node/scripts/interactive-census.mjs` drives a real Claude Code TUI through a `node-pty` PTY (settings = `probe/interactive-settings.json`, captures → `probe/captures-interactive/`). Two authorized sessions: (run 1) force a Bash permission dialog and **deny** it; (run 2) run an approved-but-failing Bash and spawn one subagent via the Task tool. Every wait is bounded; the driver group-kills on timeout and verifies no `claude` process survives.

**PermissionRequest correlation (priority finding):** the payload has **no `tool_use_id`** and no dedicated request-id. The permission gate fires *before* the tool call is assigned an id, so the bridge must correlate a PermissionRequest to its later `PreToolUse`/`PostToolUse` by **`prompt_id` + `tool_name` + `tool_input`** (a PreToolUse for the same call carries `tool_use_id`). `permission_suggestions[]` is the dialog's "always allow" options (`addRules` / `addDirectories` / `setMode`, each with a `destination` such as `session` / `localSettings`).

**Denial signal:** a denied tool fires `PreToolUse` with **no matching `PostToolUse` and no `PostToolUseFailure`** — the same "Pre without Post" absence pattern seen headless (§4.4). Only an *approved* tool that then errors yields `PostToolUseFailure`.

**`Notification`** fired once when the permission dialog appeared (`notification_type: "permission_prompt"`).

---

## 4. Adapter implications (feed into `adapter-claude/registry.ts`)

1. **Bridge:** HTTP transport for everything we verified; keep the command-forwarder path implemented but demoted to fallback. Residual unknown: whether *every* event type supports `type: "http"` — probe per-event during M2-2 registry work.
2. **Normalizer changes vs DESIGN §16.7:**
   - `assistant.message` builds from `MessageDisplay` **deltas** (accumulate by `message_id`, emit on `final: true`) — or skip display events entirely and take message content from the transcript observer; decide in M2-4 with both sources in hand.
   - `turn.started` uses `prompt_id`; keep `turn_id` as a secondary correlation field.
   - `session.ready` proxy: `SessionStart` arrives at process start; `InstructionsLoaded` (`load_reason: "session_start"`) is a useful "boot finished" refinement.
3. **Prompt confirmation (§17.2):** `UserPromptSubmit.prompt` is verbatim — exact-match against injected text is viable (normalize trailing newline only).
4. **Permission observation:** denial (headless AND interactive) is invisible beyond `PreToolUse` with no matching Post — the *absence* pattern (Pre without Post/Failure within timeout) is the "denied or stuck" signal. `PermissionRequest` itself fires at dialog-show time with no `tool_use_id` (§3.1) — the normalizer must synthesize a request id (e.g. from `prompt_id` + `tool_name` + input hash) since core's `PermissionRequestedEvent.requestId` is required.
5. **Envelope:** every event self-identifies session + transcript path — the bridge needs zero session inference; reject requests whose `session_id` isn't ours (DESIGN §16.6 rule) is trivially implementable.

---

## 5. Open items carried to M1/M2

- [x] Interactive census (M1) via `packages/node/scripts/interactive-census.mjs` (node-pty PTY): captured `PermissionRequest`, `Notification`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop` — see §3.1, fixtures added.
- [ ] `TaskCreated` / `TaskCompleted`: **not** fired by the Task-tool subagent path (that fires `Subagent*`). Find the trigger — likely the FleetView task/todo system, not the subagent tool.
- [ ] `PreCompact` / `PostCompact`: not yet exercised (needs a long/compacting session or a manual `/compact`).
- [ ] `Elicitation` / `ElicitationResult`, `TeammateIdle`, `StopFailure`: not yet exercised.
- [ ] Per-event HTTP support matrix (M2-2).
- [ ] `SessionEnd.reason` value set (only `"other"` observed).
- [ ] Whether MessageDisplay fires for thinking/tool-progress displays or only assistant text.
