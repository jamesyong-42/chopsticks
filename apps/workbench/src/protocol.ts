/**
 * Bridge-facing types (DESIGN §13.2).
 *
 * The hand-written NDJSON wire protocol between Electron main and the pty-host
 * is gone: session transport is now the avocado SDK (UDSServer hub in main, an
 * IPCSessionHost in the pty-host). What remains here is only the contract across
 * the preload bridge — the renderer↔main IPC surface exposed on
 * `window.chopsticks`. Session ids are opaque to the renderer (they are avocado
 * namespaced ids, `ipc|<transportId>|<sessionId>`). Terminal bytes still cross
 * the boundary base64-encoded so raw/malformed UTF-8 survives intact (ADR-004).
 *
 * Claude sessions ride the SAME id space: a Claude session's `runtimeSessionId`
 * IS the namespaced manager id, so its terminal output/input/replay flow through
 * the existing chunk/write/exit surface unchanged. What is new is the agent
 * observation surface (createClaudeSession / submitPrompt / onAgentEvents /
 * onAgentState) layered on top — the driver runs in Electron main, so the
 * renderer only ever sees serialized snapshots, never the live ClaudeSession.
 */

// Type-only imports: erased at build time, so the runtime adapter/core code is
// never pulled into the sandboxed preload or the browser renderer bundle.
import type { AgentEventEnvelope, ObservationLevel } from '@vibecook/chopsticks-core';
import type {
  WorkspaceDiff,
  WorkspaceErrorCode,
  WorkspaceIsolation,
  WorkspaceSessionMetadata,
} from '@vibecook/chopsticks-workspaces';

// Re-exported (type-only, erased) so preload/renderer import the workspace
// shapes from the one protocol module rather than reaching into the package.
export type { WorkspaceDiff, WorkspaceIsolation, WorkspaceSessionMetadata } from '@vibecook/chopsticks-workspaces';

/** Renderer-chosen shorthands expanded to a command by the pty-host (never the renderer). */
export type SessionKind = 'shell' | 'fake-agent';

/** Renderer-visible session creation options mirrored across the preload bridge. */
export interface CreateSessionOptions {
  kind?: SessionKind;
  /** Explicit executable; omitted when `kind` is used. */
  command?: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
}

/** Metadata for one live (or exited) session, as the renderer sees it. */
export interface SessionDescriptor {
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  exited: boolean;
}

/** A batch element: raw terminal output for one session. Ordering is the wire order. */
export interface ChunkEvent {
  sessionId: string;
  dataBase64: string;
}

export interface ExitEvent {
  sessionId: string;
  exitCode: number | null;
  /** Signal name (e.g. "SIGTERM") — rides avocado's session:end since 0.2.2. */
  signal: string | null;
  /** Classification for display: completed | crash | signal. */
  reason: string;
}

/**
 * Reload-recovery payload: the hub proxy's full output buffer as a single
 * base64 blob. Sequence-based replay is gone — the avocado proxy session's
 * CircularOutputBuffer is the reload source now.
 */
export interface ReplayResult {
  snapshotBase64: string;
}

// ───────────────────────── Claude session surface ─────────────────────────

/** Renderer-visible options for starting a Claude session; cwd defaults main-side. */
export interface CreateClaudeSessionOptions {
  /** Working directory; when omitted, main defaults it to the chopsticks repo root. */
  cwd?: string;
  title?: string;
  /**
   * Workspace isolation (DESIGN §20). Omitted → `{ isolation: 'shared' }` on the
   * repo root (current behavior). The UI offers only shared/worktree; `copy` is a
   * valid provider but deliberately not surfaced here yet. `path` defaults to
   * `cwd` (then the repo root) main-side.
   */
  workspace?: { isolation: 'shared' | 'worktree'; path?: string };
  /**
   * Resume an existing Claude session by its `--session-id` UUID (native
   * `--resume`; the session keeps its transcript and id). The resumed session is
   * a NEW runtime tab but the SAME Claude session. The renderer reuses the
   * original session's directory as a SHARED workspace on resume rather than
   * materializing a fresh worktree — see the resume path in renderer/main.ts.
   */
  resume?: string;
}

/** The workspace a Claude session is running in, as the renderer first sees it. */
export interface WorkspaceInfo {
  isolation: WorkspaceIsolation;
  /** The session's cwd (worktree/copy root, or the shared repo root). */
  root: string;
  /** worktree only: the branch that holds the session's work product. */
  branch?: string;
  initialCommit?: string;
}

/**
 * What `createClaudeSession` returns. `runtimeSessionId` is the namespaced
 * manager id — the SAME id the terminal chunk/write/exit surface uses, so the
 * renderer keys its Claude tab by it. `sessionId` is the Claude `--session-id`
 * UUID (the spaghetti join contract), surfaced for display/diagnostics only.
 */
export interface ClaudeSessionInfo {
  sessionId: string;
  runtimeSessionId: string;
  descriptor: SessionDescriptor;
  workspace: WorkspaceInfo;
}

/**
 * Structured failure for createClaudeSession when the workspace can't be set up
 * (policy conflict, or create failed). Distinguished from success by the `error`
 * key so the renderer can surface the code/message instead of an opaque throw.
 */
export interface ClaudeSessionFailure {
  error: { code: WorkspaceErrorCode; message: string };
}

export type CreateClaudeSessionResult = ClaudeSessionInfo | ClaudeSessionFailure;

/**
 * Pushed once, when a Claude session's PTY exits: the finalized workspace record.
 * For a worktree that could not be destroyed because it held uncommitted work,
 * `retained` is true and `reason` explains — the worktree and branch are kept
 * (uncommitted work is never silently discarded).
 */
export interface WorkspaceFinalEvent {
  runtimeSessionId: string;
  metadata: WorkspaceSessionMetadata;
  retained: boolean;
  reason?: string;
}

/** SessionRuntimeState (DESIGN §15) with its Maps flattened to arrays for structured-clone across IPC. */
export interface SerializedSessionState {
  lifecycle: string;
  activeTurn?: { id?: string; startedAt: string };
  tools: { toolCallId: string; tool?: string; state: 'requested' | 'running'; input?: unknown }[];
  permissions: { requestId: string; toolCallId?: string; tool?: string }[];
  subagents: { subagentId: string; agentType?: string }[];
  tasks: { taskId: string; description?: string }[];
  lastAssistantMessage?: string;
  exit?: { exitCode?: number; signal?: string; reason?: string };
  counters: { toolsCompleted: number; toolsFailed: number; unknownEvents: number };
  lastSequence: number;
  diagnostics: { sequence: number; code: string; message: string }[];
}

/** One batched agent-event push element: which session, and the stamped envelope. */
export interface AgentEventMessage {
  runtimeSessionId: string;
  envelope: AgentEventEnvelope;
}

/** A state snapshot push: the serialized reducer state plus the honest observation level. */
export interface AgentStateMessage {
  runtimeSessionId: string;
  state: SerializedSessionState;
  observationLevel: ObservationLevel;
}

// ───────────────────────── Codex session surface ──────────────────────────

/** Renderer-visible options for starting a Codex session (native TUI + observer). */
export interface CreateCodexSessionOptions {
  /** Working directory; defaults to the chopsticks repo root main-side. */
  cwd?: string;
  /**
   * Resume an existing Codex thread by id (`codex resume <id> --remote`). The
   * resumed session is a NEW terminal tab that reopens the SAME thread (its
   * history + rollout). The id is the thread id the observer reported.
   */
  resume?: string;
}

/**
 * What `createCodexSession` returns. A Codex session is a native `codex --remote`
 * terminal (runtimeSessionId = the PTY id, sharing the chunk/write/exit surface)
 * PLUS a structured observer in main that feeds the SAME agentEvents/agentState
 * channels (Model B: the user drives the native TUI, chopsticks observes over the
 * app-server). `threadId` is the Codex thread id (the spaghetti join) once the
 * observer attaches — undefined at creation (the thread appears on first prompt).
 */
export interface CodexSessionInfo {
  runtimeSessionId: string;
  descriptor: SessionDescriptor;
  threadId?: string;
}

// ───────────────────────── Grok session surface ───────────────────────────

/** Renderer-visible options for starting a Grok session (native TUI + ACP control). */
export interface CreateGrokSessionOptions {
  /** Working directory; defaults to the chopsticks repo root main-side. */
  cwd?: string;
  /**
   * Resume an existing Grok session by id (`grok --resume <id>` for the TUI +
   * ACP `session/load`). The resumed session is a NEW terminal tab attached to
   * the SAME session on the shared leader (history intact). The id is the ACP
   * session id `createGrokSession` returned.
   */
  resume?: string;
}

/**
 * What `createGrokSession` returns. A Grok session (M6 A6c) is a native `grok`
 * TUI in a PTY (runtimeSessionId = the PTY id, sharing chunk/write/exit) attached
 * to a shared `grok agent leader`, PLUS an ACP control client in main
 * (`createAcpSession` over `grok agent --leader … stdio`) that observes AND
 * drives the SAME session — feeding the agentEvents/agentState channels and
 * injecting deterministically via `session/prompt`. `sessionId` is the ACP
 * session id (the spaghetti join), known at creation (unlike Codex's thread).
 */
export interface GrokSessionInfo {
  runtimeSessionId: string;
  descriptor: SessionDescriptor;
  sessionId: string;
}

/** Programmatic prompt injection request (DESIGN §17); text is pasted verbatim then submitted. */
export interface SubmitPromptOptions {
  runtimeSessionId: string;
  text: string;
}

/** Injection outcome (DESIGN §17): `uncertain` is first-class, never collapsed to success/failure. */
export type PromptReceipt =
  | { status: 'confirmed'; turnId?: string }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string };

/**
 * The full renderer API surface exposed on `window.chopsticks` by the preload
 * (DESIGN §13.2). Deliberately narrow: no Node APIs, no arbitrary IPC channels.
 * `onChunk`/`onExit`/`onAgentEvents`/`onAgentState` return an unsubscribe function.
 */
export interface ChopsticksBridge {
  createSession(opts: CreateSessionOptions): Promise<SessionDescriptor>;
  write(sessionId: string, dataBase64: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  terminate(sessionId: string): Promise<void>;
  replay(sessionId: string): Promise<ReplayResult>;
  list(): Promise<SessionDescriptor[]>;
  onChunk(cb: (chunks: ChunkEvent[]) => void): () => void;
  onExit(cb: (exit: ExitEvent) => void): () => void;
  // Claude session surface (driver lives in main; renderer sees snapshots only).
  createClaudeSession(opts: CreateClaudeSessionOptions): Promise<CreateClaudeSessionResult>;
  // Codex session surface: a native `codex --remote` terminal + a structured
  // observer in main (shares the agentEvents/agentState channels above).
  createCodexSession(opts: CreateCodexSessionOptions): Promise<CodexSessionInfo>;
  // Grok session surface: a native `grok` TUI on a shared leader + an ACP control
  // client in main (shares the agentEvents/agentState channels; deterministic inject).
  createGrokSession(opts: CreateGrokSessionOptions): Promise<GrokSessionInfo>;
  submitPrompt(opts: SubmitPromptOptions): Promise<PromptReceipt>;
  onAgentEvents(cb: (events: AgentEventMessage[]) => void): () => void;
  onAgentState(cb: (state: AgentStateMessage) => void): () => void;
  // Workspace surface: live diff for the panel, and the final record on exit.
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  onWorkspaceFinal(cb: (event: WorkspaceFinalEvent) => void): () => void;
}
