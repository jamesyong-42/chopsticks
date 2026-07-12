/**
 * Wire protocol between Electron main and the pty-host child (DESIGN §13, §22.5).
 *
 * The pty-host runs under system Node (via tsx) and owns every PTY; main never
 * imports node-pty. Framing is NDJSON over the child's stdin/stdout: one JSON
 * object per line. Requests carry a numeric `id` and are answered by exactly one
 * response with the same `id`; unsolicited chunk/exit `event` frames are not
 * correlated to any request. Terminal bytes cross the boundary base64-encoded so
 * raw/malformed UTF-8 survives intact (ADR-004).
 */

/** Renderer-chosen shorthands expanded to a command by the pty-host (never the renderer). */
export type SessionKind = 'shell' | 'fake-agent';

export interface SpawnRequest {
  id: number;
  op: 'spawn';
  /** Explicit executable; omitted when `kind` is used. */
  command?: string;
  args?: string[];
  /** Shorthand resolved host-side into command/args so paths never touch the renderer. */
  kind?: SessionKind;
  cwd?: string;
  cols: number;
  rows: number;
}

export interface WriteRequest {
  id: number;
  op: 'write';
  sessionId: string;
  dataBase64: string;
}

export interface ResizeRequest {
  id: number;
  op: 'resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminateRequest {
  id: number;
  op: 'terminate';
  sessionId: string;
}

export interface ReplayRequest {
  id: number;
  op: 'replay';
  sessionId: string;
  /** Ring history with sequence > afterSequence; 0 = the full retained tail. */
  afterSequence: number;
}

export interface ListRequest {
  id: number;
  op: 'list';
}

export type HostRequest = SpawnRequest | WriteRequest | ResizeRequest | TerminateRequest | ReplayRequest | ListRequest;

/** Omit that distributes over unions (plain Omit collapses a union to its shared keys). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A request without the correlation id, i.e. the caller-supplied body. */
export type HostRequestBody = DistributiveOmit<HostRequest, 'id'>;

/** Metadata for one live (or exited) session; the pty-host is the source of truth. */
export interface SessionDescriptor {
  sessionId: string;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  lastSequence: number;
  exited: boolean;
}

export interface ReplayChunk {
  sequence: number;
  dataBase64: string;
}

export interface SpawnResult {
  session: SessionDescriptor;
}
export interface ListResult {
  sessions: SessionDescriptor[];
}
export interface ReplayResult {
  chunks: ReplayChunk[];
  /** False when older output was evicted from the ring: a truncated snapshot, not a continuation. */
  complete: boolean;
}
export interface TerminateResult {
  exitCode: number | null;
  signal: number | null;
}

export type HostResponse =
  | ({ id: number; ok: true } & (SpawnResult | ListResult | ReplayResult | TerminateResult | Record<never, never>))
  | { id: number; ok: false; error: string };

export interface ChunkEvent {
  event: 'chunk';
  sessionId: string;
  sequence: number;
  dataBase64: string;
}

export interface ExitEvent {
  event: 'exit';
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
  /** classifyExit result (DESIGN §21.4): completed | crash | signal | user-terminated | ... */
  reason: string;
}

export type HostEvent = ChunkEvent | ExitEvent;

export type HostMessage = HostResponse | HostEvent;

/** True for event frames (no `id`); everything else is a response. */
export function isHostEvent(msg: HostMessage): msg is HostEvent {
  return typeof (msg as HostEvent).event === 'string';
}

/** Renderer-visible session creation options mirrored across the preload bridge. */
export interface CreateSessionOptions {
  kind?: SessionKind;
  command?: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
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
  terminate(sessionId: string): Promise<TerminateResult>;
  replay(sessionId: string, afterSequence: number): Promise<ReplayResult>;
  list(): Promise<SessionDescriptor[]>;
  onChunk(cb: (chunks: ChunkEvent[]) => void): () => void;
  onExit(cb: (exit: ExitEvent) => void): () => void;
}
