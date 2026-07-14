# C0 — Codex Surface Findings

**Probed:** 2026-07-13, Codex CLI **0.144.2** (`codex-cli`), macOS (darwin), Node 24.14.1
**Method:** `codex --help` + subcommand help; `~/.codex` on-disk inspection; newest rollout record shapes; `codex app-server generate-json-schema --out` (structured protocol dump). Read-only — no live Codex session was spawned (interactive/live confirmations deferred, §6).
**Plan reference:** `IMPLEMENTATION-PLAN.md` §14 (M5). Companion to `HOOK-SURFACE-FINDINGS.md` (Claude Phase 0).

---

## 0. Headline

Codex is **not** a degraded, transcript-only agent. It has the **richest control surface of any agent we've surveyed**: a full JSON-RPC 2.0 **`app-server` protocol** (v2 schema, **516 definitions**) with structured turn control, streaming semantic events, and approvals as first-class request/response. The right chopsticks adapter for Codex is a **structured driver over the app-server**, not a PTY+transcript clone of the Claude adapter.

**Consequence:** M5 (second adapter) and M6 (structured/ACP driver) **collapse into one** for Codex, because Codex's *native* surface already is a structured protocol. Building it delivers the structured-driver architecture that Gemini/ACP later slot into.

The one thing Codex *lacks* that Claude has — a dictated `--session-id` — only bites the PTY path (Strategy A). Under the structured driver (Strategy B) identity comes back clean from `ThreadStartResponse`.

---

## 1. Verdicts

| Question | Verdict |
|---|---|
| Dictated session id at spawn (`--session-id` equivalent) | **NO** — Codex mints its own UUIDv7, embedded in the rollout filename and `session_meta.payload.session_id`. The PTY-path join must be **discovered**, not dictated. |
| Structured control protocol exists | **YES** — `codex app-server` speaks JSON-RPC 2.0 over `stdio://` \| `unix://` \| `ws://IP:PORT` (`--listen`). `generate-ts` / `generate-json-schema` emit versioned bindings → chopsticks can **codegen a typed client**. |
| Clean session identity via protocol | **YES** — `ThreadStartResponse.thread` is the thread id; `TurnStartParams` requires `{ input, threadId }`. No discovered-join race under Strategy B. |
| Structured (authoritative) streaming observation | **YES** — `ServerNotification` union (188 defs): `ItemStarted/CompletedNotification`, `AgentMessageDeltaNotification`, `TurnStarted/CompletedNotification`, `CommandExecOutputDeltaNotification`, `ProcessExitedNotification`, `FileChangePatchUpdatedNotification`, `ReasoningTextDeltaNotification`, `ContextCompactedNotification`, … |
| Structured prompt injection (no bracketed-paste guessing) | **YES** — `TurnStartParams.input` + `clientUserMessageId` → deterministic confirmation (echoed back on `ItemStarted/Completed`). Also `ThreadInjectItemsParams`, `TurnSteerParams`. **No `uncertain` receipt needed.** |
| Structured approvals (observe AND respond) | **YES** — approvals are JSON-RPC **ServerRequests** the client answers: `ExecCommandApprovalParams`, `ApplyPatchApprovalParams`, `FileChangeRequestApprovalParams`, `PermissionsRequestApprovalParams`, `CommandExecutionRequestApprovalParams`, `ToolRequestUserInputParams`. Real request-ids — strictly better than Claude's absence-pattern denial. |
| Native TUI + structured control on one session | **LIKELY** — `codex --remote <ws://\|unix://> --remote-auth-token-env <ENV>` attaches the TUI to a running app-server; `codex remote-control start/stop/pair` runs the daemon with a bearer/pairing token. (Mirrors chopsticks' own loopback+token bridge shape.) **Confirm live — §6.** |
| Structured resume / fork | **YES** — `ThreadResumeParams` / `ThreadForkParams` (protocol); `codex resume [SESSION_ID] [PROMPT]` / `--last` / `codex fork` (CLI). Resume by UUID, same as Claude. |
| Command-hook / notify callback (Claude-command-hook analog) | **YES** — `notify = ["<program>", "turn-ended"]` in `config.toml`: Codex invokes a program on events. Also a first-class **hooks** system (`--dangerously-bypass-hook-trust`; `HookStarted/CompletedNotification`, `HookEventName` in the protocol) and **MCP** (`codex mcp-server`, `[mcp_servers]`). |
| Transcript is spaghetti-readable (data-plane join) | **YES** — rollout JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; spaghetti's Codex `AgentSource` already reads it. `session_meta.payload.session_id` = the join key. |

**Go/no-go on the structured driver: GO (recommended primary path).** The PTY+transcript path stays as a degraded fallback / native-TUI-only mode.

---

## 2. On-disk shape (data-plane join — spaghetti already owns this)

```
~/.codex/sessions/2026/07/13/rollout-2026-07-13T10-06-31-019f5c71-…-fabf6.jsonl
```

Rollout record types (in order): `session_meta` → `event_msg` → `response_item`* …

`session_meta.payload` (the join + provenance):
```
session_id   019f5c71-d2ce-74c1-8041-771f7fcabfa6   (UUIDv7, == filename uuid)
cwd          /Users/.../infinite-canvas-engine
originator   codex-tui
cli_version  0.144.2
git          { commit_hash, branch, repository_url }
base_instructions { text }        # full system prompt inline
context_window { window_id }
```

`cwd` + `git.commit_hash` + `timestamp` are exactly the correlation keys a **discovered-join** would use under Strategy A. Under Strategy B we don't need them — `ThreadStart` hands us the thread id directly.

---

## 3. The two adapter strategies (the M5 fork)

### Strategy A — PTY + transcript + discovered join (Claude-parallel)
Spawn `codex` in a PTY; observe semantics via the rollout file (spaghetti reads it); discover the session id by watching for the new rollout after spawn (correlate `cwd`+`git`+time); inject via bracketed paste confirmed by the rollout's recorded user message.

- **Pro:** reuses the M1 PTY spine and the Claude adapter's exact shape; a genuine "maximally different agent, same adapter shape" abstraction test.
- **Con:** **deliberately throws away Codex's best surface.** Observation is poll-latency and lossy vs the structured stream; injection is back to `uncertain` receipts; permission prompts have no positive signal; discovered-join has a race if two sessions start in one cwd near-simultaneously.
- **Verdict:** keep only as the degraded fallback / native-TUI-only mode.

### Strategy B — app-server structured driver (RECOMMENDED)
Run `codex app-server --listen unix://<sock>` (or the `remote-control` daemon); `initialize` → `ThreadStart` → drive `TurnStart` / observe `ServerNotification` stream / answer approval `ServerRequests`. Optionally attach the **native TUI** to the same daemon via `codex --remote unix://<sock> --remote-auth-token-env`.

- **Pro:** authoritative low-latency observation; deterministic structured injection (`clientUserMessageId`); structured approvals with real request-ids; clean session identity; structured resume/fork; **and** the native terminal experience on the same session. Codegen'd typed client from `generate-ts`.
- **Pro (strategic):** delivers the DESIGN §M6 structured/ACP driver architecture *inside M5*. Gemini/ACP later reuse the `StructuredDriver` seam.
- **Con:** experimental protocol (versioned v1/v2, churns); needs the app-server lifecycle managed (spawn/daemon/pair/token); more moving parts than a PTY.
- **Verdict:** **primary path.**

---

## 4. What this does to the core abstraction

The core event union + reducer were shaped by Claude's **hook + transcript** model. Codex's **structured JSON-RPC** model is a second, structurally different driver behind the same intended `AgentSession` contract. Lifting the abstraction against *both* is the real generalization test (n=2, the right time). Concretely:

- `ObservationLevel` gains a tier **above** `native-hooks`: `structured` (authoritative streaming + structured approvals).
- The event union likely gains item/turn granularity it didn't need for Claude (`item.started/completed`, reasoning deltas) — that's the union earning its keep, not Claude-shape leaking.
- The **injector** abstraction gains a `structured` implementation (TurnStart/InjectItems, deterministic confirmation) beside Claude's `guarded-paste` one.
- The **join** becomes pluggable: dictated (Claude) / structured-response (Codex-B) / discovered (Codex-A).

---

## 5. Key CLI / config surface (reference)

```
codex [PROMPT]                       interactive TUI (native)
  -C/--cd <DIR>                      working root
  -s/--sandbox read-only|workspace-write|danger-full-access
  -a/--ask-for-approval untrusted|on-request|never
  --dangerously-bypass-approvals-and-sandbox
  --add-dir <DIR>                    extra writable roots
  --no-alt-screen                    inline mode (scrollback preserved)
  -c key=value                       TOML config override (dotted paths)
  --remote <ws://|unix://> --remote-auth-token-env <ENV>   attach TUI to app-server
codex exec [PROMPT]                  non-interactive (DO NOT use for native hosting — analog of claude --print)
codex resume [SESSION_ID] [PROMPT] | --last | --all
codex fork | archive | delete | unarchive
codex app-server --listen stdio://|unix://[PATH]|ws://IP:PORT
  app-server generate-ts --out <DIR> | generate-json-schema --out <DIR>
codex remote-control start|stop|pair [--json]
codex mcp-server                     Codex as an MCP server (stdio)
config.toml: notify=[program, "turn-ended"], [mcp_servers], approvals_reviewer
```

Regenerate the protocol contract any time:
```
codex app-server generate-json-schema --out <dir>   # v1 + v2 JSON Schema
codex app-server generate-ts --out <dir>            # typed bindings for the client
```

---

## 6. Deferred to a live/interactive probe (C1 spike)

Mirrors Claude Phase 0's interactive census — these need a running Codex, not `--help`:

1. **Identity join:** confirm `ThreadStartResponse.thread` (or its id) **equals** the rollout `session_meta.session_id` → preserves the spaghetti join contract (chopsticks knows the id ⇒ spaghetti indexes the rollout under it).
2. **`initialize` handshake:** exact params/capabilities; auth for `remote-control` (`pair` code vs bearer env); whether `unix://` needs a pre-created socket path.
3. **Native TUI + control coexistence:** `codex --remote unix://<sock>` attaches to the app-server daemon *and* renders the native TUI, with `TurnStart` driven from the protocol side — no double-drive / lease conflict.
4. **Notification stream capture:** one real `ThreadStart`→`TurnStart` turn → capture the `ServerNotification` sequence verbatim as fixtures (normalizer tests, conformance).
5. **`notify` contract:** exact event names + payload the `notify` program receives (the command-forwarder fallback shape).
6. **Sandbox/approval for write-capable runs:** `-s workspace-write -a on-request` behavior through the protocol (`ThreadStartParams.approvalPolicy`/`sandbox`).

Raw v1+v2 JSON Schema was dumped during this probe (regenerable via §5); not committed (471 KB v2, version-churning) — C1 codegens from a pinned regen instead.

---

## 7. C1 live spike — CONFIRMED (2026-07-13)

Drove `codex app-server` (stdio JSON-RPC) end-to-end against live Codex, read-only sandbox: `initialize` → `initialized` → `thread/start` → `turn/start("reply pong")` → `turn/completed`. **2.8 s, model replied `pong`, zero approval requests.** Capture + distilled shapes: `probe/codex/c1-appserver-capture.jsonl`, `probe/codex/c1-notification-shapes.json`.

**Verdicts (flips §6 deferrals #1, #4; partial #2):**

| Deferral | Result |
|---|---|
| #1 thread id ↔ rollout `session_id` ↔ spaghetti join | **CONFIRMED on disk.** `thread.sessionId` == `thread.id` == rollout `session_meta.session_id` (`019f5d86-…`). `thread/start` also returns `thread.path` = the rollout file path (handed to us, like Claude's `transcript_path` — no construction). **The chopsticks↔spaghetti join is a field on the ThreadStart response.** |
| #2 `initialize` handshake / auth | **Partial.** stdio app-server used James's `~/.codex/auth.json` directly — no extra auth. Handshake = `initialize`(requires `clientInfo{name,version}`) → server result carries `{userAgent, codexHome, platformFamily, platformOs}` → client MUST send the `initialized` notification before `thread/*`. `remote-control`/`pair`/bearer path still untested (only needed for the `--remote` TUI attach, C6). |
| #4 notification stream fixtures | **CAPTURED.** Sequence for one turn: `thread/started` → `turn/started` → `item/started`(userMessage) → `item/completed`(userMessage) → `item/started`(agentMessage) → `item/agentMessage/delta` → `item/completed`(agentMessage) → `thread/tokenUsage/updated` → `turn/completed`. Plus ambient `remoteControl/status/changed`, `mcpServer/startupStatus/updated`, `thread/status/changed`, `account/rateLimits/updated`. |

**Payload → core `AgentEvent` mapping (C2 preview):**

| Codex notification | Shape (key fields) | → core event |
|---|---|---|
| `turn/started` | `{threadId, turn:{id, status:"inProgress", startedAt}}` | `turn.started` (turnId = `turn.id`) |
| `item/completed` type `userMessage` | `{id, clientId, content:[{type:"text",text}]}` | user prompt echo — **`clientId` is the injection-confirmation channel** (set `TurnStartParams.clientUserMessageId`, match it here → deterministic, no `uncertain` receipt) |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` | streaming assistant text (structured — carries `itemId`, unlike Claude's `MessageDisplay`) |
| `item/completed` type `agentMessage` | `{id, text, phase:"final_answer", memoryCitation}` | `assistant.message` (`phase` = `final_answer` \| commentary → the final/streaming discriminator) |
| `turn/completed` | `{threadId, turn:{id, status:"completed", durationMs}}` | `turn.completed` |
| `thread/tokenUsage/updated` | `{tokenUsage:{total,last:{totalTokens,inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens}}, modelContextWindow}` | token accounting — **per-turn tokens the rollout file can't give; spaghetti's Codex source shows `—` tokens, the protocol has them** |

**Protocol facts learned (corrections to §1/§5 assumptions):**
- Client method strings are `thread/start`, `turn/start` (also `turn/steer`, `turn/interrupt`, `thread/inject_items`, `thread/resume`, `thread/fork`). Full list dumped from `ClientRequest.json`.
- `ThreadStartParams.sandbox` is a **`SandboxMode` string** (`"read-only"`), **not** the `SandboxPolicy` object — sending the object errors `-32600 invalid value: map, expected map with a single key`.
- `ThreadStartParams.approvalPolicy` = `AskForApproval` string (`"never"` \| `"on-request"` \| `"untrusted"` \| `{granular:{…}}`).
- `TurnStartParams` = `{ threadId, input:[UserInput] }` where `UserInput` = `{type:"text", text}` (or image). Turn identity (`turn.id`) is returned on `turn/started`, distinct from `thread.id`.

**Still deferred (later phases, not blocking):** #3 native-TUI-via-`codex --remote unix://` coexistence with protocol-side `TurnStart` (C6); #5 `notify` payload (superseded by the protocol for observation); #6 write-mode approvals (`workspace-write` + approval `ServerRequest` round-trip — C4).

**C1 verdict: GO — the structured driver is real, identity-clean, and spaghetti-joinable.** Proceed to C2 (normalizer over these captures).

---

## 8. C6a — native-TUI coexistence probe (`--remote` over WebSocket)

Resolves §6 deferral #3, live against codex 0.144.2. Probes: `probe/codex/c6-ws-probe.mjs`, `c6-pty-attach-probe.mjs`.

**The socket transport is WebSocket, not NDJSON — on BOTH unix and TCP.** `codex app-server --listen` accepts `stdio://` (NDJSON), `unix://<sock>`, and `ws://IP:PORT`. Every *socket* transport (unix **and** TCP) frames JSON-RPC as **WebSocket**; only `stdio://` is NDJSON. Raw NDJSON/`Content-Length` to a socket gets silence (it's waiting for a WS upgrade). **WebSocket-over-UDS is verified** (`c6-ws-uds` probe: `HTTP/1.1 101 Switching Protocols` over the unix socket, then `initialize`/`thread/start`). **UDS is the preferred C6 transport** — no port allocation/collision, filesystem-permission scoped, not network-exposed. Gotchas: `--listen unix://` needs a **real path** (macOS `/tmp` is a symlink → the app-server's `lstat` rejects it with "not a directory"); the server logs "binds localhost only" and exposes `/readyz` + `/healthz`. **Localhost/UDS needs NO auth token** (the `--remote-auth-token-env` bearer is for remote/pairing access). Client note: Node's **built-in `WebSocket` is TCP-only**, so WS-over-UDS needs either the `ws` package (`ws+unix://`) or a ~70-line hand-rolled WS client (the probe proves it's small).

**Same JSON-RPC over WS.** `initialize → thread/start → notifications` behave exactly as stdio. `thread/list` → `{ data: [...] }`; `thread/read` → `{ thread: {...} }` (incl. the rollout path).

**The native TUI attaches and renders.** `codex --remote ws://127.0.0.1:PORT` under a real PTY (node-pty) renders the native Codex TUI (the `╭─ OpenAI Codex (v0.144.2) ─╮` banner, prompt, model/dir) — no auth, no errors.

**Coexistence CONFIRMED — the C6 model.** With a controller WS client AND the native TUI attached to the *same* app-server: the user types a prompt in the TUI → a new thread is created (`preview` = the prompt) → the controller observes it (`thread/list` picks it up, `thread/read` returns it, and it receives `thread/started` + `thread/status/changed` notifications). The TUI renders the assistant reply. **Native terminal + structured observation on one server, one thread.**

**C6 observation flow — CONFIRMED.** Broadcast notifications give a controller only thread-level events (`thread/started`, `thread/status/changed`), NOT the turn/item stream for a thread it didn't *initiate*. Subscription is **implicit**: there is no `thread/subscribe`, only `thread/unsubscribe`. `thread/resume {threadId}` returns the thread's history AND **opens the live stream** — verified (`c6-subscribe` probe): after the controller resumed a TUI-created thread, a second prompt typed in the TUI delivered the full stream to the controller (`turn/started → item/started → item/completed → item/agentMessage/delta → thread/tokenUsage/updated → turn/completed`). So the Model-B flow is: observe `thread/started` → `thread/resume` (history + live subscribe) → normalizer. This is a distinct lifecycle from `createCodexSession` (which `thread/start`s its own thread) → the adapter needs a **`createCodexObserver`** entry (shipped C6-2, live-tested).

**Materialization caveat (found building the observer):** a thread has **no rollout until its first user message** — `thread/resume`/`thread/read` right after `thread/started` error with "no rollout found" / "not materialized yet; includeTurns unavailable before first user message". So the observer **retries `thread/resume`** after `thread/started` until the first turn materializes the thread (a moment later), then observes forward. `thread/started` **does** broadcast to other connections (verified), so discovery is fine; only the resume must wait for materialization.

**C6 verdict: GO.** Model: chopsticks main spawns one `codex app-server --listen unix://<sock>` (UDS preferred over TCP — no port, filesystem-scoped), connects a **WS-over-UDS controller** (observe + inject), and the renderer PTY runs `codex --remote unix://<sock>` for the native display. Needs a **WebSocket-over-UDS `Transport`** for the app-server client — the injected-transport seam (C4) already supports this, so **no driver changes**, just a new transport implementation (`ws` pkg or the ~70-line hand-rolled client from the probe). §6 #3 resolved.
