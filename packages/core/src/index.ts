/**
 * @vibecook/chopsticks-core — contracts for the chopsticks agent runtime.
 *
 * Zero I/O by design (DESIGN §8, acceptance criterion 19): types, the session
 * state reducer, and pure helpers only. Anything touching a PTY, process,
 * socket, or file lives in @vibecook/chopsticks-node or an adapter package.
 *
 * Seeded 2026-07-12 from draft/DESIGN.md §5/§14/§19 with corrections from the
 * Phase 0 probe (draft/HOOK-SURFACE-FINDINGS.md).
 */

/** DESIGN ADR-001 — native-tui is a first-class mode, not a fallback. */
export type AgentExecutionMode = 'native-tui' | 'structured' | 'acp';

/** DESIGN §19.2 — the runtime must never overstate what it can observe. */
export type ObservationLevel = 'native-hooks' | 'native-log' | 'workspace-process' | 'terminal-only';

/** DESIGN §14.1 — where a normalized event came from. */
export type AgentEventSource =
  | 'native-hook'
  | 'native-transcript'
  | 'workspace'
  | 'process'
  | 'terminal-inference'
  | 'runtime';

export type AgentEventConfidence = 'authoritative' | 'derived' | 'inferred';

/**
 * DESIGN §14.1, adjusted per Phase 0: Claude Code supplies BOTH a prompt id
 * (user-turn correlation, present on all post-prompt hook events) and a
 * distinct turn id (assistant response cycle, seen on MessageDisplay).
 * The envelope keeps both rather than collapsing them.
 */
export interface AgentEventEnvelope<T = unknown> {
  /** Monotonic per session, assigned by the runtime at ingestion. */
  sequence: number;
  sessionId: string;
  nativeSessionId?: string;
  promptId?: string;
  turnId?: string;
  timestamp: string;
  monotonicTime: number;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  event: T;
  /** DESIGN ADR-008 — the raw native event is always retained. */
  nativeEvent?: unknown;
}

export interface EnvelopeStamper {
  next<T>(fields: Omit<AgentEventEnvelope<T>, 'sequence'>): AgentEventEnvelope<T>;
}

/**
 * Sequence numbers are assigned at ingestion, before fan-out, so every
 * consumer observes the same order (DESIGN §12.1 applies the same rule to
 * terminal chunks).
 */
export function createEnvelopeStamper(): EnvelopeStamper {
  let sequence = 0;
  return {
    next(fields) {
      sequence += 1;
      return { sequence, ...fields };
    },
  };
}

export const CHOPSTICKS_CORE_VERSION = '0.0.0';
