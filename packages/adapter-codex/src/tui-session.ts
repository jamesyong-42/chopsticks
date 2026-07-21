/**
 * createCodexTuiSession — the full Codex native-TUI session recipe as one
 * `AgentSession` (the host integration, lifted out of the app).
 *
 * A Codex TUI session is three things the adapter owns end to end:
 *   1. a private `codex app-server` on a unix socket (backing service),
 *   2. a controller-owned thread on that server — `thread/start` (or resume of
 *      a known id) plus empty `inject_items` so the rollout materializes without
 *      a user prompt or model turn (probe 2026-07-15),
 *   3. a native `codex resume <id> --remote` TUI spawned through the host's
 *      terminal capability (the tab the user drives), observing the SAME thread.
 *
 * Owning the thread first is what lets the agent panel leave `preparing`
 * immediately (session.started → ready), matching Claude/Grok. Bare
 * `codex --remote` only creates a thread on the first prompt, which left the
 * panel stuck on preparing until the user typed.
 *
 * Injection is still bracketed-paste into the native TUI; confirmation is
 * best-effort `confirmed` (the structured driver has deterministic receipts).
 */

import type {
  AgentEventEnvelope,
  AgentHost,
  AgentSession,
  AgentTuiSessionOptions,
  PromptReceipt,
  PromptSubmission,
  SessionRuntimeState,
  TerminalSpec,
} from '@vibecook/chopsticks-core';
import { createCodexObserver } from './observer.js';
import type { CodexApprovalDecision, CodexApprovalRequest } from './driver.js';
import { spawnAppServer } from './ws-transport.js';
import { wsOverUnixTransport } from './ws-transport.js';

export interface CreateCodexTuiSessionOptions extends AgentTuiSessionOptions {
  /** Codex executable (default `codex`). */
  executable?: string;
  /** Choose which thread to attach to when several appear (passive observer only). */
  selectThread?: (threadId: string) => boolean;
  /** Model id applied when starting a fresh thread. */
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  /** Decide structured approval requests from the controller-owned app-server connection. Default: deny. */
  onApproval?: (req: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>;
}

/** A Codex native-TUI session — {@link AgentSession} plus the rollout path. */
export interface CodexTuiSession extends AgentSession {
  /** Absolute path to the observed thread's rollout JSONL, once attached. */
  threadPath(): string | undefined;
}

export interface PreparedCodexTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<CodexTuiSession>;
  dispose(): Promise<void>;
}

/** Prepare the private app-server, owned thread, and native TUI recipe without spawning the TUI. */
export async function prepareCodexTuiSession(opts: CreateCodexTuiSessionOptions): Promise<PreparedCodexTuiSession> {
  const executable = opts.executable ?? 'codex';
  const host: AgentHost = opts.host;

  const server = spawnAppServer({ executable });
  try {
    await server.ready();
  } catch (err) {
    server.dispose();
    throw err;
  }

  // Observer first: own or resume the thread so sessionId + ready state exist
  // before the TUI process is even spawned.
  let observer: Awaited<ReturnType<typeof createCodexObserver>>;
  try {
    observer = await createCodexObserver({
      transport: wsOverUnixTransport(server.socketPath),
      selectThread: opts.selectThread,
      onApproval: opts.onApproval,
      ...(opts.resume
        ? { threadId: opts.resume }
        : {
            start: {
              cwd: opts.cwd,
              model: opts.model,
              sandbox: opts.sandbox,
              approvalPolicy: opts.approvalPolicy,
            },
          }),
    });
  } catch (err) {
    server.dispose();
    throw err;
  }

  const threadId = observer.sessionId;
  if (!threadId) {
    await observer.dispose().catch(() => undefined);
    server.dispose();
    throw new Error('codex TUI session: observer returned no thread id');
  }

  // Always join the owned/resumed thread — never bare `--remote` (that creates
  // a second, unmaterialized thread on first keystroke).
  const remoteAddr = `unix://${server.socketPath}`;
  const args = ['resume', threadId, '--remote', remoteAddr];

  const launch: TerminalSpec = { command: executable, args, cwd: opts.cwd };
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: CodexTuiSession | undefined;
  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await observer.dispose().catch(() => undefined);
    server.dispose();
  }

  return {
    sessionId: observer.sessionId ?? threadId,
    launch,
    async adopt(runtimeSessionId): Promise<CodexTuiSession> {
      if (disposed) throw new Error('prepared Codex session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Codex session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = {
        get sessionId(): string {
          return observer.sessionId ?? threadId;
        },
        runtimeSessionId,
        state: (): SessionRuntimeState => observer.state(),
        observationLevel: () => observer.observationLevel(),
        threadPath: () => observer.threadPath(),
        onEvent: (listener: (e: AgentEventEnvelope) => void) => observer.onEvent(listener),
        async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
          const result = await host.automateTerminal(runtimeSessionId, {
            kind: 'paste',
            text: submission.text,
            submit: submission.mode !== 'paste-only',
          });
          return result.accepted ? { status: 'confirmed' } : { status: 'rejected', reason: result.reason };
        },
        dispose,
      };
      return adoptedSession;
    },
    dispose,
  };
}

export async function createCodexTuiSession(opts: CreateCodexTuiSessionOptions): Promise<CodexTuiSession> {
  const prepared = await prepareCodexTuiSession(opts);
  try {
    const { runtimeSessionId } = await opts.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (err) {
    await prepared.dispose();
    throw err;
  }
}
