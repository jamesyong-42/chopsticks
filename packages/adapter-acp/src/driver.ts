/**
 * Generic ACP session driver (M6 / A3) — the structured-driver composition for
 * ANY Agent Client Protocol agent (Grok first; the point is genericity). Sibling
 * of the Codex `createCodexSession`: Codex speaks its own app-server JSON-RPC,
 * ACP speaks the standardized protocol, but both are `structured` drivers —
 * observation AND control run over the protocol, there is no PTY.
 *
 *   initialize → newSession (or loadSession, resume)   (identity: the ACP
 *                                                        sessionId is the
 *                                                        spaghetti join key)
 *     → sessionUpdate → normalizer → envelope stamping → session reducer
 *     → requestPermission → structured approvals (observe + answer)
 *     → submitPrompt = session/prompt (deterministic — no `uncertain` receipt)
 *
 * TURN FRAMING lives here, not the normalizer: ACP has no turn-boundary
 * notification — `session/prompt` is one request that resolves with a
 * `stopReason`. So `submitPrompt` synthesizes `turn.started` before the request
 * and `turn.completed`/`turn.failed` when it settles. It does NOT await the
 * request (which resolves only at end-of-turn); the receipt confirms acceptance,
 * the turn completes later via events — same contract as the Codex driver.
 *
 * `observationLevel()` is honestly `'structured'`. Hosting a native TUI beside
 * this driver (Grok's leader mode) is the workbench's job (A6);
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
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  Agent,
  Client,
  ClientCapabilities,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { AcpNotificationNormalizer } from './normalizer.js';
import { spawnAcpConnection, type AcpConnector } from './connection.js';

export type AcpApprovalDecision = 'approved' | 'denied';

export interface AcpApprovalRequest {
  toolCallId: string;
  tool?: string;
  input?: unknown;
  options: PermissionOption[];
}

export interface CreateAcpSessionOptions {
  cwd: string;
  /** Connector override (tests). Defaults to spawning `grok agent stdio`. */
  connector?: AcpConnector;
  /** Executable for the default spawn connector. Default `grok`. */
  executable?: string;
  /** Args for the default spawn connector. Default `['agent', 'stdio']`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Resume an existing ACP session by id (`session/load`, replays history). */
  resume?: string;
  /** Client capabilities to advertise. Default: filesystem disabled. */
  clientCapabilities?: ClientCapabilities;
  /**
   * Decide structured permission requests. Default: deny (safe) — a runtime
   * that wants the agent to act must supply a policy.
   */
  onApproval?: (req: AcpApprovalRequest) => AcpApprovalDecision | Promise<AcpApprovalDecision>;
}

/** No adapter-specific extras yet; the shared contract is the whole surface. */
export type AcpSession = AgentSession;

/** Pick the ACP permission option matching an approve/deny decision. */
function decideOutcome(decision: AcpApprovalDecision, options: PermissionOption[]): RequestPermissionResponse {
  const prefix = decision === 'approved' ? 'allow' : 'reject';
  const chosen = options.find((o) => o.kind.startsWith(prefix));
  // No matching option offered → cancel (which the agent treats as "not allowed").
  if (!chosen) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
}

export async function createAcpSession(options: CreateAcpSessionOptions): Promise<AcpSession> {
  const normalizer = new AcpNotificationNormalizer();
  const stamper = createEnvelopeStamper();

  let state = createInitialSessionState();
  let sessionId = '';
  let currentTurnId: string | undefined;
  let turnCounter = 0;
  let turnAssistantText = '';
  let disposed = false;
  const observation: ObservationLevel = 'structured';
  const listeners = new Set<(e: AgentEventEnvelope) => void>();

  function apply(event: AgentEvent, source: AgentEventEnvelope['source']): void {
    const envelope = stamper.next({
      sessionId,
      nativeSessionId: sessionId,
      turnId: currentTurnId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source,
      confidence: 'authoritative',
      event,
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

  const buildClient = (_agent: Agent): Client => ({
    sessionUpdate(params: SessionNotification): void {
      const { events } = normalizer.normalize(params);
      for (const event of events) {
        // Track the running assistant text so turn.completed can seal
        // lastAssistantMessage (ACP has no per-message `final` marker).
        if (event.type === 'assistant.message') turnAssistantText = event.text;
        apply(event, 'native-hook');
      }
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const requestId = params.toolCall.toolCallId;
      const tool = params.toolCall.title ?? params.toolCall.kind ?? undefined;
      apply(
        {
          type: 'permission.requested',
          requestId,
          toolCallId: requestId,
          tool,
          input: params.toolCall.rawInput,
          presentation: 'host-ui',
        },
        'native-hook',
      );
      const decision = options.onApproval
        ? await options.onApproval({
            toolCallId: requestId,
            tool,
            input: params.toolCall.rawInput,
            options: params.options,
          })
        : 'denied';
      apply(
        { type: 'permission.resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
        'native-hook',
      );
      return decideOutcome(decision, params.options);
    },
  });

  const connector =
    options.connector ??
    spawnAcpConnection({ executable: options.executable, args: options.args, cwd: options.cwd, env: options.env });
  const conn = connector(buildClient);

  conn.onClose(({ code, signal }) => {
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

  await conn.agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: options.clientCapabilities ?? { fs: { readTextFile: false, writeTextFile: false } },
  });

  if (options.resume) {
    // `loadSession` is optional in ACP (advertised via capability). Resume works
    // only against agents that support it — surface that plainly rather than
    // silently starting a fresh session under the caller's resume id.
    if (!conn.agent.loadSession) {
      conn.close();
      throw new Error('ACP agent does not support session/load — cannot resume');
    }
    sessionId = options.resume;
    await conn.agent.loadSession({ sessionId: options.resume, cwd: options.cwd, mcpServers: [] });
  } else {
    const res = await conn.agent.newSession({ cwd: options.cwd, mcpServers: [] });
    sessionId = res.sessionId;
  }

  apply({ type: 'session.started', nativeSessionId: sessionId }, 'native-hook');

  return {
    sessionId,
    runtimeSessionId: sessionId,
    state: () => state,
    observationLevel: () => observation,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      const turnId = `acp-turn-${++turnCounter}`;
      currentTurnId = turnId;
      turnAssistantText = '';
      apply({ type: 'turn.started', turnId, prompt: submission.text }, 'native-hook');
      // Fire-and-observe: session/prompt resolves only at END of turn, so we do
      // NOT await it. The synthesized turn.completed (below) fires when it does.
      // (`prompt` returns MaybePromise — normalize with Promise.resolve.)
      void Promise.resolve(conn.agent.prompt({ sessionId, prompt: [{ type: 'text', text: submission.text }] }))
        .then((res: PromptResponse) =>
          apply(
            {
              type: 'turn.completed',
              turnId,
              stopReason: res.stopReason,
              lastAssistantMessage: turnAssistantText || undefined,
            },
            'native-hook',
          ),
        )
        .catch((err: unknown) =>
          apply(
            { type: 'turn.failed', turnId, error: err instanceof Error ? err.message : String(err) },
            'native-hook',
          ),
        );
      // ACP injection is structured and atomic — deterministic confirmation.
      return { status: 'confirmed', turnId };
    },
    notifyUserInput() {
      /* no PTY in the structured driver; the native-TUI attach (A6) wires this */
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      conn.close();
    },
  };
}
