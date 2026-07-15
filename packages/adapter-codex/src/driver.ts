/**
 * Codex session driver — the structured-driver composition (M5 C4; DESIGN
 * ADR-006 `structured` driver). The counterpart to Claude's hook+PTY
 * `createClaudeSession`, but Codex's native surface IS a structured protocol,
 * so observation and control both run over the app-server JSON-RPC:
 *
 *   initialize → initialized → thread/start   (identity: thread.sessionId is the
 *                                              spaghetti join key; thread.path is
 *                                              the rollout file)
 *     → onNotification → normalizer → envelope stamping → session reducer
 *     → onServerRequest → structured approvals (observe + answer)
 *     → submitPrompt = turn/start (deterministic confirmation — no `uncertain`)
 *
 * There is NO PTY here: the structured driver observes and drives via the
 * protocol. `observationLevel()` is honestly `'structured'`. Hosting the native
 * TUI beside it (via `codex --remote`) is the workbench's job (C6);
 * `notifyUserInput()` is the seam that wiring will use.
 */

import { performance } from 'node:perf_hooks';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentSession,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
} from '@vibecook/chopsticks-core';
import { AppServerClient, spawnAppServerTransport, type Transport } from './app-server-client.js';
import { CodexNotificationNormalizer } from './normalizer.js';

const CLIENT_INFO = { name: 'chopsticks', version: '0.0.0' } as const;

export type CodexApprovalDecision = 'approved' | 'denied';

export interface CodexApprovalRequest {
  /** The server-request method, e.g. an exec/apply-patch/permission approval. */
  method: string;
  params: Record<string, unknown> | undefined;
  requestId: number | string;
}

export interface CreateCodexSessionOptions {
  cwd: string;
  /** Transport override (tests). Defaults to spawning `codex app-server`. */
  transport?: Transport;
  executable?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  /** Resume an existing thread by id (`thread/resume`) instead of starting fresh. */
  resume?: string;
  /**
   * Decide structured approval requests. Default: deny (safe) — a runtime that
   * wants the agent to act must supply a policy.
   */
  onApproval?: (req: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>;
}

export interface CodexSession extends AgentSession {
  /** Absolute path to this session's rollout JSONL (the Codex transcript analog). */
  threadPath(): string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export async function createCodexSession(options: CreateCodexSessionOptions): Promise<CodexSession> {
  const transport = options.transport ?? spawnAppServerTransport({ executable: options.executable });
  const client = new AppServerClient(transport);
  const normalizer = new CodexNotificationNormalizer();
  const stamper = createEnvelopeStamper();

  let state = createInitialSessionState();
  let sessionId = '';
  let runtimeSessionId = '';
  let threadPath: string | undefined;
  let currentTurnId: string | undefined;
  let injectionCounter = 0;
  const observation: ObservationLevel = 'structured';
  const listeners = new Set<(e: AgentEventEnvelope) => void>();

  function apply(event: AgentEvent, source: AgentEventEnvelope['source'], nativeEvent?: unknown): void {
    const envelope = stamper.next({
      sessionId,
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
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch {
        /* listener faults stay out of the pipeline */
      }
    }
  }

  client.onNotification((method, params) => {
    // Capture identity as early as the thread/started notification (it arrives
    // during the thread/start request, before its response resolves).
    if (method === 'thread/started') {
      const thread = rec(params?.thread);
      if (thread) {
        sessionId ||= str(thread.sessionId) ?? str(thread.id) ?? '';
        runtimeSessionId ||= str(thread.id) ?? sessionId;
        threadPath ??= str(thread.path);
      }
    }
    const norm = normalizer.normalize({ method, params });
    if (norm.turnId) currentTurnId = norm.turnId;
    for (const event of norm.events) apply(event, 'native-hook', { method, params });
  });

  client.onServerRequest(async (method, params, id) => {
    // Structured approval: observe it, decide, answer, record the resolution.
    const requestId = String(id);
    apply(
      { type: 'permission.requested', requestId, tool: method, input: params, presentation: 'host-ui' },
      'native-hook',
      { method, params, id },
    );
    const decision = options.onApproval ? await options.onApproval({ method, params, requestId: id }) : 'denied';
    apply(
      { type: 'permission.resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
      'native-hook',
      { method, params, id },
    );
    // UNVERIFIED response shape — no live approval fixture yet (the pong turn had
    // none). Confirm the exact field against a workspace-write probe.
    return { decision };
  });

  client.onClose(({ code, signal }) => {
    apply(
      {
        type: 'process.exited',
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
        reason: signal ? 'signal' : code === 0 ? 'completed' : 'crash',
      },
      'runtime',
    );
  });

  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
  client.notify('initialized');

  const startResult = options.resume
    ? await client.request('thread/resume', { threadId: options.resume })
    : await client.request('thread/start', {
        cwd: options.cwd,
        sandbox: options.sandbox ?? 'workspace-write',
        approvalPolicy: options.approvalPolicy ?? 'on-request',
      });

  const thread = rec(rec(startResult)?.thread);
  if (thread) {
    sessionId = str(thread.sessionId) ?? str(thread.id) ?? sessionId;
    runtimeSessionId = str(thread.id) ?? (runtimeSessionId || sessionId);
    threadPath = str(thread.path) ?? threadPath;
  }

  return {
    sessionId,
    runtimeSessionId,
    state: () => state,
    observationLevel: () => observation,
    threadPath: () => threadPath,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      // Structured injection: the app-server echoes our exact input, so a
      // successful turn/start is deterministic confirmation — never `uncertain`.
      const clientUserMessageId = `chopsticks-inj-${++injectionCounter}`;
      try {
        await client.request('turn/start', {
          threadId: runtimeSessionId,
          input: [{ type: 'text', text: submission.text }],
          clientUserMessageId,
        });
        return { status: 'confirmed', turnId: currentTurnId };
      } catch (err) {
        return { status: 'rejected', reason: err instanceof Error ? err.message : String(err) };
      }
    },
    notifyUserInput() {
      /* no PTY in the structured driver; the native-TUI attach (C6) wires this */
    },
    async dispose() {
      client.close();
    },
  };
}
