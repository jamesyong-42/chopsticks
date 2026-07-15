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
 * Agent sessions ride the SAME id space: `runtimeSessionId` is the namespaced
 * manager id, so terminal output/input/replay flow through the existing surface.
 * Provider details stay behind @vibecook/chopsticks-runtime; this bridge exposes
 * one create/observe/control contract regardless of the selected agent.
 */

// Type-only imports: erased at build time, so the runtime adapter/core code is
// never pulled into the sandboxed preload or the browser renderer bundle.
import type {
  AgentEventEnvelope,
  ObservationLevel,
  PromptReceipt as CorePromptReceipt,
} from '@vibecook/chopsticks-core';
import type {
  AgentSessionInfo as RuntimeAgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
  BuiltinAgentKind,
} from '@vibecook/chopsticks-runtime';
import type { WorkspaceDiff, WorkspaceErrorCode } from '@vibecook/chopsticks-workspaces';

// Re-exported (type-only, erased) so preload/renderer import the workspace
// shapes from the one protocol module rather than reaching into the package.
export type { WorkspaceDiff, WorkspaceMode } from '@vibecook/chopsticks-workspaces';

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

// ───────────────────────── Agent session surface ──────────────────────────

export type AgentKind = BuiltinAgentKind;

/** Renderer-visible options shared by every agent provider. */
export interface CreateAgentSessionOptions {
  agent: AgentKind;
  cwd?: string;
  title?: string;
  /**
   * Workspace mode. Omitted means direct access to cwd/default root.
   */
  workspace?: {
    mode: 'direct' | 'exclusive' | 'worktree';
    path?: string;
    resumeBranch?: string;
    resumeRoot?: string;
  };
  /**
   * Resume by the provider's opaque native session id. The adapter owns the
   * actual resume mechanism and identity contract.
   */
  resume?: string;
}

/** The workspace an agent session is running in. */
export type WorkspaceInfo = AgentWorkspaceInfo;

/**
 * One provider-neutral result. sessionId is an opaque native/join id;
 * runtimeSessionId is the host terminal routing id.
 */
export interface AgentSessionInfo extends Omit<RuntimeAgentSessionInfo, 'agent'> {
  agent: AgentKind;
  descriptor: SessionDescriptor;
}

/**
 * Structured creation failure (unknown provider, workspace policy, or setup).
 */
export interface AgentSessionFailure {
  error: { code: WorkspaceErrorCode | 'AGENT_NOT_FOUND'; message: string };
}

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

/**
 * Pushed once, when any agent session's PTY exits: its finalized workspace record.
 * For a worktree that could not be destroyed because it held uncommitted work,
 * `retained` is true and `reason` explains — the worktree and branch are kept
 * (uncommitted work is never silently discarded).
 */
export type WorkspaceFinalEvent = AgentWorkspaceFinal;

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

/** Programmatic prompt injection request (DESIGN §17); text is pasted verbatim then submitted. */
export interface SubmitPromptOptions {
  runtimeSessionId: string;
  text: string;
}

/** Injection outcome (DESIGN §17): `uncertain` is first-class, never collapsed to success/failure. */
export type PromptReceipt = CorePromptReceipt;

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
  createAgentSession(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  submitPrompt(opts: SubmitPromptOptions): Promise<PromptReceipt>;
  onAgentEvents(cb: (events: AgentEventMessage[]) => void): () => void;
  onAgentState(cb: (state: AgentStateMessage) => void): () => void;
  // Workspace surface: live diff for the panel, and the final record on exit.
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  onWorkspaceFinal(cb: (event: WorkspaceFinalEvent) => void): () => void;
}
