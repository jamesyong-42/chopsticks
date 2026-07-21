/**
 * Grok's native-TUI recipe (leader + TUI + ACP control) as one `AgentSession`.
 *
 * Grok-specific behavior contained here:
 *   1. a shared `grok agent leader`, spawned once and owned by the backend;
 *   2. a native `grok --leader` TUI spawned through the host terminal;
 *   3. a generic ACP client attached to the leader session, with Grok-specific
 *      command arguments and retry behavior while the TUI registers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpSession, createStdioAcpConnector } from '@vibecook/chopsticks-adapter-acp';
import type { CreateAcpSessionOptions } from '@vibecook/chopsticks-adapter-acp';
import {
  createInitialSessionState,
  type AgentEventEnvelope,
  type AgentHost,
  type AgentSession,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
  type SessionRuntimeState,
  type TerminalSpec,
} from '@vibecook/chopsticks-core';

export interface CreateGrokBackendOptions {
  /** Grok executable (default `grok`). */
  executable?: string;
  /** The host terminal capability the TUI is spawned through. */
  host: AgentHost;
}

export interface GrokBackend {
  /** Start a Grok tab: native TUI + a control client attached to the same session. */
  createSession(opts: CreateGrokSessionOptions): Promise<AgentSession>;
  /** Prepare leader wiring and a native launch recipe without spawning the TUI. */
  prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession>;
  /** Tear down the shared leader (host shutdown). */
  dispose(): void;
}

export interface CreateGrokSessionOptions {
  cwd: string;
  resume?: string;
  /** Model id passed to the native Grok TUI. */
  model?: string;
  /** Grok permission mode. Kept open because the CLI's modes evolve. */
  permissionMode?: string;
  /** Grok sandbox profile passed to the native TUI. */
  sandbox?: string;
  /** ACP capabilities advertised by the structured control client. */
  clientCapabilities?: CreateAcpSessionOptions['clientCapabilities'];
  /** Decide ACP permission requests. Default: deny. */
  onApproval?: CreateAcpSessionOptions['onApproval'];
}

export interface PreparedGrokSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AgentSession>;
  dispose(): Promise<void>;
}

/** Bind a prepared Grok recipe to exactly one caller-owned terminal. */
export function createPreparedGrokSession(
  sessionId: string,
  launch: TerminalSpec,
  attach: () => Promise<AgentSession>,
): PreparedGrokSession {
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: AgentSession | undefined;
  let disposed = false;

  return {
    sessionId,
    launch,
    async adopt(runtimeSessionId): Promise<AgentSession> {
      if (disposed) throw new Error('prepared Grok session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Grok session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = createPendingControlSession(sessionId, runtimeSessionId, attach);
      return adoptedSession;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await adoptedSession?.dispose().catch(() => undefined);
    },
  };
}

/** Build the native TUI invocation for a new or resumed leader-owned session. */
export function buildGrokTuiArgs(
  socketPath: string,
  sessionId: string,
  opts: Pick<CreateGrokSessionOptions, 'resume' | 'model' | 'permissionMode' | 'sandbox'>,
): string[] {
  const args: string[] = [];
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.permissionMode !== undefined) args.push('--permission-mode', opts.permissionMode);
  if (opts.sandbox !== undefined) args.push('--sandbox', opts.sandbox);
  args.push('--leader', '--leader-socket', socketPath);
  args.push(opts.resume ? '--resume' : '--session-id', sessionId);
  return args;
}

/** Attach ACP control to an existing Grok leader session, retrying while the TUI registers it. */
async function attachControl(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string,
  opts: Pick<CreateGrokSessionOptions, 'clientCapabilities' | 'onApproval'>,
): Promise<AgentSession> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  let lastErr: unknown;
  for (let i = 0; i < 15; i++) {
    try {
      return await createAcpSession({
        cwd,
        connector: createStdioAcpConnector({ executable, args, cwd }),
        resume: sessionId,
        clientCapabilities: opts.clientCapabilities,
        onApproval: opts.onApproval,
      });
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('grok ACP control attach failed');
}

/**
 * A Grok TUI session whose ACP control client attaches asynchronously. The TUI
 * is usable immediately; observation and prompt injection bind once attach
 * succeeds.
 */
export function createPendingControlSession(
  sessionId: string,
  runtimeSessionId: string,
  attach: () => Promise<AgentSession>,
): AgentSession {
  const listeners = new Set<(event: AgentEventEnvelope) => void>();
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
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch {
          /* listener faults stay out of the pipeline */
        }
      }
    });
    return acp;
  });
  controlReady.catch(() => undefined);

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
      const acp = control ?? (await controlReady.catch(() => undefined));
      if (!acp) return { status: 'rejected', reason: 'grok control client not attached' };
      return acp.submitPrompt(submission);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (control) await control.dispose().catch(() => undefined);
    },
  };
}

export function createGrokBackend(options: CreateGrokBackendOptions): GrokBackend {
  const executable = options.executable ?? 'grok';
  const host = options.host;
  let leader: { socketPath: string; child: ChildProcess } | undefined;

  async function ensureLeader(): Promise<string> {
    if (leader && leader.child.exitCode === null && !leader.child.killed) return leader.socketPath;
    // macOS /tmp is a symlink the agent's socket bind rejects — use the real tmp.
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chopsticks-grok-'));
    const socketPath = join(dir, 'leader.sock');
    const child = spawn(
      executable,
      ['agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--leader-socket', socketPath],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 80 && !existsSync(socketPath); i++) await new Promise((resolve) => setTimeout(resolve, 250));
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

  async function prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession> {
    const { cwd, resume } = opts;
    const socketPath = await ensureLeader();
    const sessionId = resume ?? randomUUID();
    const launch: TerminalSpec = {
      command: executable,
      args: buildGrokTuiArgs(socketPath, sessionId, opts),
      cwd,
    };
    return createPreparedGrokSession(sessionId, launch, () =>
      attachControl(executable, cwd, socketPath, sessionId, opts),
    );
  }

  return {
    prepareSession,

    async createSession(opts): Promise<AgentSession> {
      const prepared = await prepareSession(opts);
      try {
        const { runtimeSessionId } = await host.spawnTerminal(prepared.launch);
        return await prepared.adopt(runtimeSessionId);
      } catch (err) {
        await prepared.dispose();
        throw err;
      }
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
