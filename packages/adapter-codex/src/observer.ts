/**
 * Codex thread observer (M5 C6) — attach to a thread and feed the shared
 * normalizer + reducer. Two attach modes:
 *
 * 1. **Passive (legacy Model B):** wait for `thread/started` from another
 *    connection (e.g. a bare `codex --remote` TUI), then `thread/resume` until
 *    the rollout materializes. Used by live tests that drive a separate
 *    `createCodexSession`.
 *
 * 2. **Controller-owned (workbench default):** this connection
 *    `thread/start`s (or resumes a known id), materializes with an empty
 *    `thread/inject_items` so resume/TUI work without a user prompt, then
 *    opens the live stream. Proven 2026-07-15
 *    (`probe/codex/controller-owned-thread-probe3.mjs`): empty inject writes
 *    the rollout without a model turn, so the panel can go `ready` immediately
 *    and the TUI joins via `codex resume <id> --remote`.
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

const CLIENT_INFO = { name: 'chopsticks-observer', version: '0.1.0' } as const; // x-release-please-version

/** Empty inject materializes a rollout without a model turn (probe 3). */
const MATERIALIZE_ITEMS = [{ type: 'text', text: '' }] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export interface CreateCodexObserverOptions {
  transport: Transport;
  /** Choose which thread to attach to when several appear. Default: the first. */
  selectThread?: (threadId: string) => boolean;
  /**
   * Attach immediately to this existing thread (resume path) instead of waiting
   * for `thread/started`. The thread must already be materializable (has a
   * rollout) — real Codex resumes always do.
   */
  threadId?: string;
  /**
   * Create + materialize a fresh thread on this connection so the session is
   * ready before any TUI attaches. Mutually exclusive with {@link threadId}.
   */
  start?: {
    cwd: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  };
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
  if (opts.threadId && opts.start) {
    throw new Error('createCodexObserver: pass threadId OR start, not both');
  }

  const client = new AppServerClient(opts.transport);
  const normalizer = new CodexNotificationNormalizer();
  const stamper = createEnvelopeStamper();

  let state = createInitialSessionState();
  let sessionId: string | undefined;
  let threadPath: string | undefined;
  let currentTurnId: string | undefined;
  let attached = false;
  let attaching = false;
  let disposed = false;
  const observation: ObservationLevel = 'structured';
  const listeners = new Set<(e: AgentEventEnvelope) => void>();
  const threadListeners = new Set<(info: CodexThreadInfo) => void>();

  function apply(event: AgentEvent, source: AgentEventEnvelope['source'], nativeEvent?: unknown): void {
    const envelope = stamper.next({
      sessionId: sessionId ?? '',
      nativeSessionId: sessionId,
      turnId: currentTurnId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source,
      confidence: 'authoritative',
      event,
      nativeEvent,
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

  /**
   * Open the live stream for `threadId` via `thread/resume`, then mark ready.
   * Retries while the rollout is missing (passive mode: TUI's first turn is
   * still writing it). Controller-owned mode materializes first so this is a
   * single success.
   */
  async function attach(threadId: string, thread: Record<string, unknown> | undefined): Promise<void> {
    if (attached || attaching) return;
    attaching = true;
    sessionId = threadId;
    threadPath = str(thread?.path) ?? threadPath;
    // A thread isn't materializable until it has a rollout. Passive-created threads
    // only write one on the first user message; controller-owned threads write
    // one via empty inject_items before calling attach. Retry until it takes,
    // the connection drops, or we're disposed — a bounded one-shot was the
    // "stuck at preparing, no messages" bug when a slow first turn missed it.
    let delay = 200;
    while (!attached && !disposed) {
      try {
        await client.request('thread/resume', { threadId }); // history + opens the live stream
        attached = true;
      } catch {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(Math.floor(delay * 1.5), 2000);
      }
    }
    if (!attached) {
      attaching = false; // disposed before the thread ever materialized
      return;
    }
    apply({ type: 'session.started', nativeSessionId: threadId }, 'native-hook');
    for (const l of threadListeners) l({ threadId, path: threadPath });
  }

  client.onNotification((method, params) => {
    if (!attached) {
      // Passive mode only: wait for another client (the TUI) to create a thread.
      // Controller-owned start/resume never relies on this path.
      if (!opts.threadId && !opts.start && method === 'thread/started') {
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
    for (const event of norm.events) apply(event, 'native-hook', { method, params });
  });

  client.onClose(() => {
    disposed = true; // let any in-flight attach retry loop exit
    if (attached) apply({ type: 'process.exited', reason: 'signal' }, 'runtime');
  });

  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
  client.notify('initialized');

  // Controller-owned bootstrap: create + materialize, or resume a known id,
  // before returning so callers can spawn `codex resume <id> --remote` with a
  // ready join key and the panel can leave `preparing` immediately.
  if (opts.start) {
    const startResult = await client.request('thread/start', {
      cwd: opts.start.cwd,
      sandbox: opts.start.sandbox ?? 'workspace-write',
      approvalPolicy: opts.start.approvalPolicy ?? 'on-request',
    });
    const thread = rec(rec(startResult)?.thread);
    const tid = str(thread?.id) ?? str(thread?.sessionId);
    if (!tid) {
      client.close();
      throw new Error('codex thread/start returned no thread id');
    }
    threadPath = str(thread?.path);
    // Empty text item materializes the rollout without a model turn (probe 3).
    // Without this, thread/resume and `codex resume --remote` fail with
    // "no rollout found" until the user types.
    await client.request('thread/inject_items', { threadId: tid, items: [...MATERIALIZE_ITEMS] });
    await attach(tid, thread);
    if (!attached) {
      client.close();
      throw new Error(`codex observer failed to attach to owned thread ${tid}`);
    }
  } else if (opts.threadId) {
    await attach(opts.threadId, undefined);
    if (!attached) {
      client.close();
      throw new Error(`codex observer failed to attach to thread ${opts.threadId}`);
    }
  }

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
      disposed = true; // stop the attach retry loop if it is still running
      client.close();
    },
  };
}
