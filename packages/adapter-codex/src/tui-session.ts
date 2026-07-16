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
} from '@vibecook/chopsticks-core';
import { createCodexObserver } from './observer.js';
import { spawnAppServer } from './ws-transport.js';
import { wsOverUnixTransport } from './ws-transport.js';

export interface CreateCodexTuiSessionOptions extends AgentTuiSessionOptions {
  /** Codex executable (default `codex`). */
  executable?: string;
  /** Choose which thread to attach to when several appear (passive observer only). */
  selectThread?: (threadId: string) => boolean;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
}

/** A Codex native-TUI session — {@link AgentSession} plus the rollout path. */
export interface CodexTuiSession extends AgentSession {
  /** Absolute path to the observed thread's rollout JSONL, once attached. */
  threadPath(): string | undefined;
}

export async function createCodexTuiSession(opts: CreateCodexTuiSessionOptions): Promise<CodexTuiSession> {
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
  let observer;
  try {
    observer = await createCodexObserver({
      transport: wsOverUnixTransport(server.socketPath),
      selectThread: opts.selectThread,
      ...(opts.resume
        ? { threadId: opts.resume }
        : {
            start: {
              cwd: opts.cwd,
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

  let runtimeSessionId: string;
  try {
    ({ runtimeSessionId } = await host.spawnTerminal({ command: executable, args, cwd: opts.cwd }));
  } catch (err) {
    await observer.dispose().catch(() => undefined);
    server.dispose();
    throw err;
  }

  let disposed = false;
  return {
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
    async dispose() {
      if (disposed) return;
      disposed = true;
      await observer.dispose().catch(() => undefined);
      server.dispose();
    },
  };
}
