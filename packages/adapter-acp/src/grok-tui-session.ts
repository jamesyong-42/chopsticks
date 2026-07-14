/**
 * createGrokBackend — the full Grok native-TUI recipe (leader + TUI + ACP
 * control) as one `AgentSession` per tab, lifted out of the app (M6 A6c).
 *
 * Grok's native-TUI + leader coexistence is three things the adapter now owns:
 *   1. a shared `grok agent leader` (spawned once, lazily; the backend owns it),
 *   2. a native `grok --leader` TUI spawned through the host terminal capability
 *      (the tab), which OWNS session creation (`--session-id <uuid>` for a new
 *      tab so the welcome shows and `session_start` fires once; `--resume <id>`
 *      to reopen). `--leader` is REQUIRED so the TUI joins OUR leader,
 *   3. an ACP control client that ATTACHES to that same session on the leader
 *      (observe + deterministic `session/prompt` inject), retried while the TUI
 *      registers it, and wired in asynchronously so it never blocks the terminal.
 *
 * The app used to manage the leader, spawn the TUI, and run the attach loop
 * itself; now it holds ONE backend and calls `createSession` per tab. The leader
 * lives until `backend.dispose()` (host shutdown).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createInitialSessionState,
  type AgentEventEnvelope,
  type AgentHost,
  type AgentSession,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
  type SessionRuntimeState,
} from '@vibecook/chopsticks-core';
import { createAcpSession } from './driver.js';

export interface CreateGrokBackendOptions {
  /** Grok executable (default `grok`). */
  executable?: string;
  /** The host terminal capability the TUI is spawned through. */
  host: AgentHost;
}

export interface GrokBackend {
  /** Start a Grok tab: native TUI + a control client attached to the same session. */
  createSession(opts: { cwd: string; resume?: string }): Promise<AgentSession>;
  /** Tear down the shared leader (host shutdown). */
  dispose(): void;
}

/** Attach an ACP control client to an EXISTING leader session, retrying while
 *  the TUI is still registering it (loadSession 404s until then). */
async function attachControl(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string,
): Promise<AgentSession> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  let lastErr: unknown;
  for (let i = 0; i < 15; i++) {
    try {
      return await createAcpSession({ cwd, executable, args, resume: sessionId });
    } catch (err) {
      lastErr = err; // a failed loadSession closes its own transport (driver)
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('grok ACP control attach failed');
}

/**
 * The pending-control session wrapper (extracted for testing). The native TUI is
 * up (id + terminal) but the ACP control client attaches asynchronously via
 * `attach()`; until it lands the session is usable but "starting":
 * - `onEvent` listeners buffer and are forwarded once control attaches,
 * - `submitPrompt` awaits the attach then delegates (rejects if it never lands),
 * - `state()` reports the initial reducer state until control's is available,
 * - `dispose()` before attach cancels the eventual control client.
 */
export function createPendingControlSession(
  sessionId: string,
  runtimeSessionId: string,
  attach: () => Promise<AgentSession>,
): AgentSession {
  const listeners = new Set<(e: AgentEventEnvelope) => void>();
  let control: AgentSession | undefined;
  let disposed = false;
  const observation: ObservationLevel = 'structured';

  const controlReady = attach().then((acp) => {
    if (disposed) {
      void acp.dispose().catch(() => undefined);
      return undefined;
    }
    control = acp;
    acp.onEvent((envelope) => {
      for (const l of listeners) {
        try {
          l(envelope);
        } catch {
          /* listener faults stay out of the pipeline */
        }
      }
    });
    return acp;
  });
  controlReady.catch(() => undefined); // unhandled-rejection guard; surfaced via submitPrompt

  return {
    sessionId,
    runtimeSessionId,
    state: (): SessionRuntimeState => control?.state() ?? createInitialSessionState(),
    observationLevel: () => observation,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      // `.catch` here (not just the guard above): if the attach REJECTED,
      // awaiting the raw promise would throw — we want a `rejected` receipt.
      const acp = control ?? (await controlReady.catch(() => undefined));
      if (!acp) return { status: 'rejected', reason: 'grok control client not attached' };
      return acp.submitPrompt(submission);
    },
    notifyUserInput() {
      /* the user drives the native TUI directly; nothing to arbitrate here */
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (control) await control.dispose().catch(() => undefined);
    },
  };
}

export function createGrokBackend(opts: CreateGrokBackendOptions): GrokBackend {
  const executable = opts.executable ?? 'grok';
  const host = opts.host;
  let leader: { socketPath: string; child: ChildProcess } | undefined;

  async function ensureLeader(): Promise<string> {
    if (leader && leader.child.exitCode === null && !leader.child.killed) return leader.socketPath;
    // macOS /tmp is a symlink the agent's socket bind rejects — use the real tmp.
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chopsticks-grok-'));
    const socketPath = join(dir, 'leader.sock');
    // `--relay-on-demand`: interactive client — defer the grok.com relay (avoid a
    // startup round-trip and remote-prompt pulls).
    const child = spawn(
      executable,
      ['agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--leader-socket', socketPath],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 80 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 250));
    if (!existsSync(socketPath)) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      throw new Error('grok agent leader failed to start (no socket)');
    }
    leader = { socketPath, child };
    return socketPath;
  }

  return {
    async createSession({ cwd, resume }): Promise<AgentSession> {
      const socketPath = await ensureLeader();
      // We dictate the id to BOTH clients. A fresh tab → `--session-id` (a NEW
      // conversation → welcome shows); resume → `--resume`. `--leader` is required
      // so the TUI joins our leader and shares the live session with the control
      // client (otherwise the TUI runs standalone and injection wouldn't reach it).
      const sessionId = resume ?? randomUUID();
      const tuiArgs = resume
        ? ['--leader', '--leader-socket', socketPath, '--resume', sessionId]
        : ['--leader', '--leader-socket', socketPath, '--session-id', sessionId];
      const { runtimeSessionId } = await host.spawnTerminal({ command: executable, args: tuiArgs, cwd });

      // The control client attaches asynchronously so the terminal is never
      // blocked on it. The returned session is usable immediately (id + terminal),
      // buffers onEvent listeners, and binds them once control lands.
      return createPendingControlSession(sessionId, runtimeSessionId, () =>
        attachControl(executable, cwd, socketPath, sessionId),
      );
    },

    dispose(): void {
      if (!leader) return;
      try {
        leader.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      leader = undefined;
    },
  };
}
