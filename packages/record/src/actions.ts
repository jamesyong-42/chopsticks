/**
 * Own-action record (DESIGN §22.1, rescoped 2026-07-13).
 *
 * The append-only log of what the chopsticks RUNTIME itself did — the one
 * class of data with no other emitter. Injection receipts, workspace finals,
 * exit classifications, and policy conflicts exist nowhere in an agent's
 * transcript (the agent never knew about them), so per the emitter-writes-a-
 * file rule chopsticks writes them down; Spaghetti can index the file later
 * if search is ever wanted. This is NOT a mirror of agent history and never
 * grows into one.
 */

export interface OwnActionBase {
  /** ISO timestamp, stamped at append. */
  ts: string;
  /** The Claude `--session-id` UUID — the join key into Spaghetti's index. */
  sessionId: string;
  /** The host's runtime session id (terminal/attach routing), when distinct. */
  runtimeSessionId?: string;
}

/** A programmatic prompt injection and its honest receipt (DESIGN §17). */
export interface InjectionAction extends OwnActionBase {
  type: 'injection';
  text: string;
  outcome: 'confirmed' | 'rejected' | 'uncertain';
  reason?: string;
  turnId?: string;
}

/** Workspace finalize metadata at session end (DESIGN §20.4). */
export interface WorkspaceFinalAction extends OwnActionBase {
  type: 'workspace-final';
  isolation: 'shared' | 'worktree' | 'copy';
  branch?: string;
  initialCommit?: string;
  finalCommit?: string;
  filesTouched: string[];
  /** True when a dirty worktree was kept rather than destroyed. */
  retained?: boolean;
}

/** Process exit as classified by the runtime (DESIGN §21.4). */
export interface SessionExitAction extends OwnActionBase {
  type: 'session-exit';
  exitCode: number | null;
  signal?: string | null;
  reason: string;
}

/** A workspace policy refusal (DESIGN §20.3) — a session that never started. */
export interface PolicyConflictAction extends OwnActionBase {
  type: 'policy-conflict';
  code: string;
  message: string;
}

export type OwnAction = InjectionAction | WorkspaceFinalAction | SessionExitAction | PolicyConflictAction;

/** The fields a caller supplies; `ts` is stamped by the recorder. */
export type OwnActionInput = { [K in OwnAction as K['type']]: Omit<K, 'ts'> }[OwnAction['type']];
