/**
 * Codex thread observer (M5 C6, Model B) — attach to a thread the *native TUI*
 * created and observe it, rather than starting our own (that's
 * `createCodexSession`). This is how the workbench watches a `codex --remote`
 * session: the user drives the native terminal, chopsticks observes.
 *
 * Flow (CODEX-SURFACE-FINDINGS §8): a controller connection sees `thread/started`
 * broadcast when the TUI creates a thread, then `thread/resume` opens that
 * thread's live turn/item stream (subscription is implicit — there is only
 * `thread/unsubscribe`). Those notifications feed the same normalizer + reducer
 * as the driver, so observation state is identical regardless of who drives.
 *
 * Observe-from-attach: the resume returns history, but we start the reduced
 * state from `session.started` and reduce live events forward; replaying history
 * turns is a future enrichment, not needed for live observation.
 */

import { performance } from 'node:perf_hooks';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type AgentEventEnvelope,
  type ObservationLevel,
  type SessionRuntimeState,
} from '@vibecook/chopsticks-core';
import { AppServerClient, type Transport } from './app-server-client.js';
import { CodexNotificationNormalizer } from './normalizer.js';

const CLIENT_INFO = { name: 'chopsticks-observer', version: '0.0.0' } as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export interface CreateCodexObserverOptions {
  transport: Transport;
  /** Choose which thread to attach to when several appear. Default: the first. */
  selectThread?: (threadId: string) => boolean;
}

export interface CodexThreadInfo {
  threadId: string;
  path?: string;
}

export interface CodexObserver {
  /** The observed thread's id / spaghetti join key (undefined until one attaches). */
  readonly sessionId: string | undefined;
  state(): SessionRuntimeState;
  observationLevel(): ObservationLevel;
  threadPath(): string | undefined;
  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
  /** Fires once a thread is picked up and its live stream is open. */
  onThread(listener: (info: CodexThreadInfo) => void): () => void;
  dispose(): Promise<void>;
}

export async function createCodexObserver(opts: CreateCodexObserverOptions): Promise<CodexObserver> {
  const client = new AppServerClient(opts.transport);
  const normalizer = new CodexNotificationNormalizer();
  const stamper = createEnvelopeStamper();

  let state = createInitialSessionState();
  let sessionId: string | undefined;
  let threadPath: string | undefined;
  let currentTurnId: string | undefined;
  let attached = false;
  let attaching = false;
  const observation: ObservationLevel = 'structured';
  const listeners = new Set<(e: AgentEventEnvelope) => void>();
  const threadListeners = new Set<(info: CodexThreadInfo) => void>();

  function apply(event: AgentEvent, source: AgentEventEnvelope['source']): void {
    const envelope = stamper.next({
      sessionId: sessionId ?? '',
      nativeSessionId: sessionId,
      turnId: currentTurnId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source,
      confidence: 'authoritative',
      event,
    });
    state = reduceSessionState(state, envelope);
    for (const l of listeners) {
      try {
        l(envelope);
      } catch {
        /* listener faults stay out of the pipeline */
      }
    }
  }

  async function attach(threadId: string, thread: Record<string, unknown> | undefined): Promise<void> {
    if (attached || attaching) return;
    attaching = true;
    sessionId = threadId;
    threadPath = str(thread?.path);
    // A thread isn't materialized (no rollout) until its FIRST user message, so
    // thread/resume errors ("no rollout found") right after thread/started. Retry
    // until it takes — the first turn materializes it within a moment. (Observe
    // from attach; a partial first turn is acceptable, later turns are complete.)
    for (let i = 0; i < 60 && !attached; i++) {
      try {
        await client.request('thread/resume', { threadId }); // history + opens the live stream
        attached = true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!attached) {
      attaching = false; // gave up; a later thread/started may retry
      return;
    }
    apply({ type: 'session.started', nativeSessionId: threadId }, 'native-hook');
    for (const l of threadListeners) l({ threadId, path: threadPath });
  }

  client.onNotification((method, params) => {
    if (!attached) {
      if (method === 'thread/started') {
        const thread = rec(params?.thread);
        const tid = str(thread?.id);
        if (tid && (!opts.selectThread || opts.selectThread(tid))) void attach(tid, thread);
      }
      return; // ignore everything until we've attached to a thread
    }
    // Only our thread's notifications drive state (avoid cross-thread bleed).
    const tid = str(params?.threadId) ?? str(rec(params?.thread)?.id);
    if (tid && tid !== sessionId) return;
    const norm = normalizer.normalize({ method, params });
    if (norm.turnId) currentTurnId = norm.turnId;
    for (const event of norm.events) apply(event, 'native-hook');
  });

  client.onClose(() => {
    if (attached) apply({ type: 'process.exited', reason: 'signal' }, 'runtime');
  });

  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
  client.notify('initialized');

  return {
    get sessionId() {
      return sessionId;
    },
    state: () => state,
    observationLevel: () => observation,
    threadPath: () => threadPath,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onThread(listener) {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    async dispose() {
      client.close();
    },
  };
}
