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
 */

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

/**
 * The full renderer API surface exposed on `window.chopsticks` by the preload
 * (DESIGN §13.2). Deliberately narrow: no Node APIs, no arbitrary IPC channels.
 * `onChunk`/`onExit` return an unsubscribe function.
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
}
