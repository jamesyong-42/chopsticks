/**
 * createCodexTuiSession — the full Codex native-TUI session recipe as one
 * `AgentSession` (the "Model B" host integration, lifted out of the app).
 *
 * A Codex TUI session is three things the adapter now owns end to end:
 *   1. a private `codex app-server` on a unix socket (backing service),
 *   2. a native `codex --remote` TUI spawned through the host's terminal
 *      capability (the tab the user drives),
 *   3. a structured observer over the app-server that attaches to whatever
 *      thread the TUI creates and feeds the agent event/state channels.
 *
 * The app used to wire these three together itself; now it just provides an
 * {@link AgentHost} and gets back a plain {@link AgentSession}. Injection is the
 * bracketed-paste into the native TUI (verified to record clean text on the
 * thread); confirmation is the turn appearing in the observed stream, so the
 * receipt is a best-effort `confirmed` (the structured driver, by contrast, has
 * deterministic confirmation — this is the native-TUI path).
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
  /** Choose which thread to attach to when several appear. Default: the first. */
  selectThread?: (threadId: string) => boolean;
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

  // Resume reopens the SAME thread; otherwise a fresh `codex --remote` TUI (the
  // thread materializes on the first prompt).
  const remoteAddr = `unix://${server.socketPath}`;
  const args = opts.resume ? ['resume', opts.resume, '--remote', remoteAddr] : ['--remote', remoteAddr];

  let runtimeSessionId: string;
  try {
    ({ runtimeSessionId } = await host.spawnTerminal({ command: executable, args, cwd: opts.cwd }));
  } catch (err) {
    server.dispose();
    throw err;
  }

  const observer = await createCodexObserver({
    transport: wsOverUnixTransport(server.socketPath),
    selectThread: opts.selectThread,
  }).catch((err) => {
    server.dispose();
    throw err;
  });

  let disposed = false;
  return {
    get sessionId(): string {
      // The thread id (spaghetti join) — empty until the thread materializes on
      // the first prompt; consumers that need it early read it off events.
      return observer.sessionId ?? '';
    },
    runtimeSessionId,
    state: (): SessionRuntimeState => observer.state(),
    observationLevel: () => observer.observationLevel(),
    threadPath: () => observer.threadPath(),
    onEvent: (listener: (e: AgentEventEnvelope) => void) => observer.onEvent(listener),
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      // Bracketed-paste into the native TUI, then Enter. A direct host write (not
      // the human-input path), so it is never mistaken for a keystroke.
      host.writeTerminal(runtimeSessionId, `\x1b[200~${submission.text}\x1b[201~\r`);
      return { status: 'confirmed' };
    },
    notifyUserInput() {
      /* the user drives the native TUI directly; nothing to arbitrate here */
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await observer.dispose().catch(() => undefined);
      server.dispose();
    },
  };
}
