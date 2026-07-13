# Chopsticks Implementation Plan — v0.1

**Status:** Draft for review
**Created:** 2026-07-12
**Companion:** `draft/DESIGN.md` (Native TUI Coding Agent Runtime, v0.2 — canonical copy; the one in `~/Projects/project100/temp/` is superseded)
**Sibling:** Spaghetti (`p008/spaghetti`) — the read-only data plane. Boundary: *reads bytes left on disk → spaghetti; holds a live handle to an agent process → chopsticks.*

---

## 0. Charter

> Host coding agents' **native terminal experiences** (Claude Code first) inside a managed runtime that owns the PTY, lifecycle, observation, and guarded control — reading all durable ground truth through Spaghetti, never parsing the terminal for semantics.

v0.1 = DESIGN §28 Milestones 0–2, per the scope guidance already in that doc. Everything after M2 is re-scoped against real usage.

---

## 1. Locked context (decided, do not relitigate)

| Decision | Where recorded |
|---|---|
| One native session = one agent process; no shadow `--print` process | DESIGN ADR-002 |
| Semantics from side channels (hooks → transcript → workspace/process → inference), never from VT parsing | DESIGN ADR-003/-004/-005 |
| Transcript observer = thin wrapper over Spaghetti SDK live plane, not a new parser | DESIGN §2.1, §16.8 |
| `--session-id` UUID generated at spawn = the chopsticks ↔ spaghetti join contract | DESIGN §2.1, §14.4 |
| Chopsticks persists **operational** state only; browse/search stays in Spaghetti | DESIGN §2.1, §22.1 |
| Recording default `memory-only`; `persistent-raw` opt-in; no redacted tier | DESIGN §23.3 |
| Prompt injection = guarded bracketed paste, confirmed by **matching** UserPromptSubmit payload; `PromptReceipt` may be `uncertain` | DESIGN §17.2 |
| Electron main owns PTYs; renderer is sandboxed; core package has zero Electron dependency | DESIGN ADR-007, §13 |
| Unknown native events are retained verbatim | DESIGN ADR-008 |

---

## 2. Decisions to confirm at bootstrap (proposals)

| Topic | Proposal | Notes |
|---|---|---|
| Repo | Standalone repo at `p008/chopsticks`, pnpm workspace | Mirrors spaghetti/truffle conventions (release-please, prettier, vitest, lock-step versioning) |
| npm scope | `@vibecook/chopsticks-*` | DESIGN §8's `@native-agent/*` was a placeholder |
| App location | `apps/workbench/` (Electron app, private) instead of DESIGN §8's `packages/electron` | Library/app split, same as spaghetti's `apps/playground`; the thin electron *bridge* helpers that are reusable live in `packages/electron-host` only if they prove reusable — start inside the app |
| Platform | macOS first; Linux best-effort; **Windows deferred past v0.1** (Job Objects native helper is real work) | You develop on darwin |
| Spaghetti dependency | Pin published `@vibecook/spaghetti-sdk` (0.5.16+); `pnpm link` for local iteration | Cross-repo is fine — only `adapter-claude` touches it |
| Electron/Node versions | Pin exact versions at bootstrap; `electron-rebuild` in CI from M1 day one | DESIGN §28 M1 note |
| License / publishing | Private until M2 exit | No reason to publish before the adapter works |

Bootstrap rule (global): no scaffolding tools in a directory with existing files — `git init` + commit `draft/` **first**, then add workspace files by hand or scaffold in a temp dir and copy with `cp -n`.

---

## 3. Repo layout — v0.1 trim of DESIGN §8

```text
chopsticks/
  draft/                      # this plan + DESIGN.md (move to docs/ at bootstrap)
  packages/
    core/                     # @vibecook/chopsticks-core — types, reducer, no I/O
      src/
        events.ts             #   AgentEvent union + AgentEventEnvelope (DESIGN §14)
        state.ts              #   SessionRuntimeState + reduceSessionState (DESIGN §15)
        session.ts            #   AgentSession/AgentRuntime interfaces (DESIGN §9)
        adapter.ts            #   AgentAdapter/driver interfaces (DESIGN §10–11)
        capabilities.ts       #   ObservationCapabilities/-Level (DESIGN §19)
        errors.ts             #   RuntimeError model (DESIGN §24)
        queue.ts              #   bounded async event queues
    node/                     # @vibecook/chopsticks-node — PTY + processes + pipeline
      src/
        pty.ts                #   node-pty transport → NativeProcessHandle
        process-tree.ts       #   POSIX process groups; escalation ladder (DESIGN §21.2)
        distributor.ts        #   OrderedTerminalDistributor + sink policies (DESIGN §12)
        ring-buffer.ts        #   RecentOutputRingBuffer
        headless-sink.ts      #   @xterm/headless mirror (DESIGN §12.3)
        session-manager.ts    #   runtime host: createSession/list/dispose
    adapter-claude/           # @vibecook/chopsticks-adapter-claude
      src/
        registry.ts           #   hook-event registry AS DATA (fed by Phase 0 findings)
        detection.ts          #   executable + version + capability probe
        hook-bridge.ts        #   loopback HTTP + token; command-forwarder fallback
        settings.ts           #   session settings generation from registry (DESIGN §16.5)
        native-driver.ts      #   prepare/spawn/observers (DESIGN §11, §16.2)
        normalizer.ts         #   normalizeClaudeHook (DESIGN §16.7)
        transcript-observer.ts#   wrapper over spaghetti SDK (DESIGN §16.8)
        prompt.ts             #   guarded injection + lease (DESIGN §17)
    testing/                  # @vibecook/chopsticks-testing
      src/
        fake-agent.ts         #   fixture TUI executable (DESIGN §26.1)
        fake-hook-source.ts
        fixtures/             #   captured hook payloads from Phase 0
        conformance.ts        #   adapter conformance suite (DESIGN §26.2)
  apps/
    workbench/                # Electron dev app: main host, preload API (§13.2), xterm renderer
```

Deferred packages (do **not** create yet): `workspaces/` (M3), `acp/` (M6), `adapter-codex|gemini/` (M5), persistence store (M4).

---

## 4. Phase DAG

```text
P0  Verification spike (hook surface probe)          ←  everything downstream keys off this
 │
 ▼
M0  core + testing packages (contracts, reducer, fake agent)
 │
 ▼
M1  node package + workbench app (PTY spine, terminal pipeline, reload recovery)
 │
 ▼
M2  adapter-claude (detect → bridge → spawn → normalize → transcript → inject)
      ├── S1  spaghetti-side: verify hook-type exports        (parallel, tiny)
      └── S2  spaghetti-side: scoped transcript watch         (parallel, small)
```

Rough effort at your working cadence: P0 1–2 sessions · M0 1–2 · M1 3–4 · M2 4–6.

---

## 5. Phase 0 — Verification spike (before any framework code)

DESIGN leans on hook-surface claims that are **unverified** (§16.7 warning). Every adapter file is shaped by the answers, so buy them first for a day of scripting.

Tasks:

1. **Flag probe:** `claude --help` → confirm `--session-id`, `--name`, `--settings`, `--permission-mode` exist and their argument shapes.
2. **Settings schema probe:** feed a generated settings file containing a `"type": "http"` hook; observe accept/warn/reject. Answers whether the hybrid bridge (DESIGN §16.4) is real or whether v0.1 is command-hooks-only.
3. **Event census (headless):** run `claude -p` with command hooks on every candidate event name appending raw JSON to a capture file. Diff observed names/payloads against spaghetti's canonical union (`packages/sdk/src/types/hook-events.ts`) — resolve the open questions: does `MessageDisplay` exist? does `UserPromptSubmit` carry `prompt_id`? does `PostToolUse` carry `tool_use_id`?
4. **Event census (interactive):** same settings, real PTY (`script -q` or manual), exercising a permission dialog and an interrupt — captures whatever print mode can't produce.
5. **Payload fixtures:** every captured event body → `packages/testing/src/fixtures/hooks/` verbatim (they seed the conformance suite and normalizer tests).

Deliverables: `draft/HOOK-SURFACE-FINDINGS.md` + fixtures + `registry.ts` v0 data (event name → transport → payload schema → confidence).

Exit: go/no-go on HTTP hooks; the DESIGN §16.5 settings example regenerated from *observed* reality.

Fallback already proven: if HTTP hooks don't exist, command hooks appending JSONL + a tail is exactly the spaghetti-hooks plugin mechanism running in production today. The bridge interface (DESIGN §16.6) stays; only the transport changes.

---

## 6. Milestone 0 — Core contracts

| PR | Contents | Notes |
|---|---|---|
| M0-1 | Repo bootstrap: pnpm workspace, tsconfig, vitest, prettier, CI (lint+test), release-please | Copy conventions from spaghetti/truffle; commit `draft/` first |
| M0-2 | `core`: event union + envelope, error model, execution modes, adapter interfaces, async queue | Types compile against DESIGN §9–§15 verbatim; adjust names only where Phase 0 contradicts |
| M0-3 | `core`: `reduceSessionState` + property tests (replay determinism, duplicate tolerance, unknown-event tolerance, DESIGN §26.5 list) | The reducer is the most reusable artifact in the repo — gold-plate it |
| M0-4 | `testing`: fake agent (ANSI, alt-screen, bracketed paste, permission prompt, slow flood, crash modes) + fake hook source + fixture loader | Fake agent is a plain Node script speaking stdin/stdout — runs fine under the real PTY layer in M1 |

Exit: reducer property tests + fixture-driven normalizer stubs green in CI. Zero I/O anywhere in `core`.

---

## 7. Milestone 1 — Terminal spine

| PR | Contents | Notes |
|---|---|---|
| M1-1 | `node`: node-pty transport, `NativeProcessHandle`, spawn/env construction (DESIGN §23.2 — allowlist env, don't forward parent env wholesale) | |
| M1-2 | `node`: process-tree control — POSIX process group spawn, escalation ladder (protocol-interrupt slot → Ctrl-C → SIGTERM → SIGKILL group), exit classification (§21.4) | Windows stubbed with explicit `CAPABILITY_MISSING` |
| M1-3 | `node`: `OrderedTerminalDistributor` — sequence stamping before fan-out, sink policies (required/replayable/droppable), ring buffer, `@xterm/headless` mirror, desync-→-snapshot resync (§12.4) | Backpressure tests use the fake agent's flood mode |
| M1-4 | `apps/workbench`: Electron main runtime host + session manager, preload `AgentRuntimeRendererApi` (§13.2), renderer xterm.js mount, MessagePort terminal streaming, tabs | context isolation on, node integration off, CSP strict (§23.1) — from the first commit, not retrofitted |
| M1-5 | CI: electron-rebuild wiring + node-pty smoke test | Electron e2e automation deferred; manual checklist in `draft/` for now |

Exit: `vim`, `htop`, and a raw `claude` session render and accept input correctly in workbench tabs; renderer reload restores the view from headless snapshot + ring buffer; killing a session with a child process tree leaves no orphans.

---

## 8. Milestone 2 — Claude native adapter

| PR | Contents | Notes |
|---|---|---|
| M2-1 | `adapter-claude`: registry data (from Phase 0) + detection/capability probe (§10) — probe results become `ObservationCapabilities` + degradation warnings | |
| M2-2 | Hook bridge per Phase 0 verdict: loopback HTTP w/ bearer token, body limits, per-event timeouts (§16.6) — or command-forwarder JSONL transport behind the same interface | Bridge failure ⇒ observation degrades, terminal survives (§24 example) |
| M2-3 | Settings generation from registry + `prepare/spawn`: session UUID, generated settings file, cleanup list, interactive command (§16.2–16.3) | Never pass `-p`/`--print`/stream-json flags |
| M2-4 | Normalizer (fixture-tested against Phase 0 captures) + reducer wiring + workbench activity panel showing normalized state + observation level | `assistant.message` sourced from transcript observer if `MessageDisplay` didn't survive Phase 0 |
| M2-5 | Transcript observer over spaghetti — **fallback first**: `createSpaghettiService({ live: true })` filtered by the session UUID; swap to S2's scoped watch when it ships | Parsing failure never fails the session (§16.8 rules) |
| M2-6 | Guarded prompt injection: interaction lease, bracketed paste, prompt-payload-matched confirmation, full `PromptReceipt` surface incl. `uncertain` (§17) | Conformance-tested against fake agent; opt-in real-Claude test group (§26.3) |

Exit = v0.1 acceptance (below).

---

## 9. Spaghetti-side prerequisites (small PRs in `p008/spaghetti`, parallel to M0–M1)

| ID | Work | Size |
|---|---|---|
| S1 | Verify/export hook-event types (`HookEventName`, payload types) from the SDK barrel so `adapter-claude`'s registry can import rather than redeclare | tiny |
| S2 | Scoped single-session transcript watch — a lightweight `watchSessionTranscript(path)` (or documented cheap pattern over `api.live` filtered by sessionId). Chopsticks' M2-5 fallback works without it; this removes the whole-directory watcher cost per session | small |

Both respect the settled charter: read-only, no new write paths, no chopsticks knowledge inside spaghetti — S2 is a generic API improvement.

---

## 10. v0.1 acceptance (DESIGN §29, trimmed to M0–M2)

Kept as-is: criteria 1–12, 14–16 (POSIX only), 18–20.

Amended:
- **13 →** terminal output (ring buffer, memory-only) and semantic events (in-memory log) are held separately; durable persistence is M4.
- **17 →** concurrent sessions run safely in *distinct existing directories*; worktree provisioning is M3.

---

## 11. Deferred (re-scope after M2 against real usage)

| Milestone | Work | Trigger to start |
|---|---|---|
| M3 | `workspaces/` package: worktree/copy isolation, final-diff metadata | You actually run ≥2 write-capable sessions on one repo |
| M4 (rescoped 2026-07-13) | Own-action JSONL record + native `--resume` spawn path. The SQLite event store is REJECTED — hook events mirror transcripts, which Spaghetti already indexes (same invariant as spaghetti PR #60); renderer reconnection was delivered by the avocado proxy buffer (M1.5); byte-exact terminal recording stays an opt-in flag awaiting a real consumer | Anytime — both remaining items are thin |
| M5 | **Codex adapter — structured driver over the `app-server` protocol** (see §14). C0 probe (2026-07-13) found Codex's native surface *is* a JSON-RPC structured protocol, so M5 **absorbs M6** for Codex. | C0 done; core will churn (union + observation tier) — do it before over-polishing the Claude-shaped core |
| M6 | ~~Structured + ACP drivers~~ — **largely delivered by M5's Codex structured driver**; residual = a non-Codex ACP agent | A concrete automation consumer exists; the `StructuredDriver` seam from M5 is the reuse point |
| — | Runtime daemon outside Electron main (§22.5 note) | Workbench restart pain becomes real; keep host behind an interface now so this stays a transport swap |

---

## 12. Risk register

| Risk | Mitigation |
|---|---|
| Hook surface differs from DESIGN's assumptions (`MessageDisplay`, HTTP hooks, payload fields) | Phase 0 exists precisely for this; registry-as-data + command-hook fallback keep it a data change, not a redesign |
| node-pty × Electron ABI drift | electron-rebuild in CI at M1-5; pin Electron; truffle release discipline applies |
| Renderer floods / slow-sink stalls | Sink policies + desync-snapshot protocol (§12.4) are in the M1-3 PR, not an afterthought; fake-agent flood mode in CI |
| Prompt injection breaks on TUI changes | Receipt semantics (`uncertain` is a valid answer) + conformance fixtures; never claim more certainty than the confirmation event provides |
| Claude Code's own teams/orchestration eats the intra-Claude story | Product identity = heterogeneity + observability (the spaghetti index); chopsticks differentiates on hosting *any* agent's native TUI with real state |
| Solo-dev scope creep | v0.1 gate is M2 exit, enforced by §28 scope guidance; deferred table above has explicit start-triggers |

---

## 13. Suggested first implementation session

1. `git init` in `chopsticks/`, commit `draft/` as-is.
2. Run the Phase 0 flag + settings probes (an hour of shell work); start the event census capture.
3. While captures accumulate: bootstrap the pnpm workspace (M0-1) copying spaghetti's configs.
4. Write `HOOK-SURFACE-FINDINGS.md` from the census; land the go/no-go on HTTP hooks.
5. Start M0-2 (core types) — by then the registry data tells you exactly which event names and fields are real.

---

## 14. Milestone 5 — Codex adapter (structured driver)

**Status:** planned; C0 surface probe **done** 2026-07-13 → `draft/CODEX-SURFACE-FINDINGS.md`.
**Why now (vs the "weeks of soak" gate):** the gate was a proxy for "don't abstract off one example." C0 changes the calculus — Codex's native surface is a *structured JSON-RPC protocol*, structurally unlike Claude's hook+transcript model, so it's the **right** second example to lift the core abstraction against (n=2), and it will **reshape** the core event union + observation tier. Doing it before over-polishing the Claude-shaped core is the cheaper order. Spaghetti's Codex `AgentSource` (data half) already shipped, so the data-plane join is in place.

### 14.1 The decision (from C0)

Two strategies exist; **Strategy B (app-server structured driver) is primary**, Strategy A (PTY+transcript, discovered-join) is kept only as a degraded fallback / native-TUI-only mode. See `CODEX-SURFACE-FINDINGS.md` §3. Net effect: **M5 absorbs M6** — Codex delivers the structured/ACP driver architecture; Gemini/ACP later reuse its `StructuredDriver` seam.

### 14.2 Phase plan

| PR | Contents | Notes |
|---|---|---|
| **C1** — app-server spike + codegen | `codex app-server generate-ts` → typed client in `packages/adapter-codex` (or shared `app-server-client`); stand up `app-server --listen unix://`, do `initialize` → `ThreadStart` → one `TurnStart`, capture the `ServerNotification` stream as fixtures. **Resolves the §6 live deferrals** — esp. thread-id ↔ rollout `session_id` ↔ spaghetti join, and native-TUI-via-`--remote` coexistence. | This is the go/no-go spike, analog of Claude Phase 0's HTTP-hook verdict |
| **C2** — normalizer: `ServerNotification` → `AgentEvent` | Map the structured stream onto the core union + reducer. Where the union can't express item/turn/reasoning granularity, **extend it** — that's the abstraction earning its keep, not Claude-shape leaking. Fixture-tested against C1 captures. | |
| **C3** — lift the abstraction into `core` (n=2) | With a hook+transcript adapter (Claude) **and** a structured driver (Codex), extract `AgentSession` / `AgentAdapter` / `ObservationLevel` into `core` (the files DESIGN §9–11 describe but that were never built — core currently exports only `AgentEventEnvelope`). Add `ObservationLevel: 'structured'` above `'native-hooks'`. Refactor `createClaudeSession` to implement the lifted interface, **zero behavior change** (existing adapter-claude tests are the safety net). | The "general interface + per-source impl" move, one layer up from spaghetti's `LifecycleOwner`/`LiveWatch` |
| **C4** — structured control | Prompt injection via `TurnStart`/`ThreadInjectItems` with `clientUserMessageId` (deterministic confirmation — no `uncertain` receipt). Structured **approvals**: observe (and optionally answer) `ExecCommand`/`ApplyPatch`/`Permissions` approval `ServerRequests`. Injector abstraction gains a `structured` impl beside Claude's `guarded-paste` one. | Approvals have real request-ids — strictly better than Claude's absence-pattern denial |
| **C5** — conformance suite | Build the DESIGN §26.2 adapter conformance suite in `testing` (**currently missing**) — adapter-agnostic assertions (spawn→observe→state→inject→resume→dispose, no orphans) run against **both** adapters over the fake agent. Locks the C3 interface; pays forward to Gemini/ACP. | |
| **C6** — workbench: Codex peer tab | Host Codex beside Claude: native TUI via `codex --remote unix://<daemon>` attached to the same app-server the driver controls → structured observation **and** native terminal on one session. Panel reports `ObservationLevel: 'structured'`. | Runtime-side mirror of the spaghetti CLI's claude/codex tabs shipped 2026-07-13 |

Rough effort at your cadence: C1 ~1–2 · C2 ~2 · C3 ~1–2 · C4 ~2 · C5 ~2 · C6 ~1–2. Codegen (C1) de-risks the bulk.

### 14.3 Locked context (from C0, do not relitigate)

| Decision | Basis |
|---|---|
| Codex primary adapter = **structured app-server driver**, not PTY+transcript | CODEX-SURFACE-FINDINGS §0/§3 |
| Never use `codex exec` for native hosting (the `--print` analog) | §5 |
| Session identity from `ThreadStartResponse`, **not** a dictated id (Codex has no `--session-id`) | §1 |
| Injection is structured (`TurnStart` + `clientUserMessageId`); the guarded-paste injector is Claude-only | §1/§3 |
| Approvals are first-class JSON-RPC `ServerRequest`s (observe + respond) | §1 |
| The protocol is experimental/versioned — pin a regen (`generate-ts`), don't hand-write the client | §5 |

### 14.4 Risks specific to Codex

| Risk | Mitigation |
|---|---|
| app-server protocol is experimental, v1/v2 churns | Codegen from a pinned `generate-ts`; version-probe at detection; the normalizer isolates protocol drift to one file |
| app-server lifecycle (daemon, pairing, token, socket) is more moving parts than a PTY | C1 spike owns exactly this; `remote-control pair`/bearer mirrors chopsticks' existing loopback+token discipline |
| Native-TUI-via-`--remote` may conflict with protocol-side `TurnStart` (double-drive) | §6 deferral #3 verifies coexistence in C1 before C6 depends on it; fall back to structured-only or TUI-only if they don't compose |
| Thread id ≠ rollout `session_id` would break the spaghetti join | §6 deferral #1 — the very first C1 assertion; if they differ, add an explicit id-map (still deterministic, just one hop) |
