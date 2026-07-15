/**
 * ACP transport wiring (M6 / A3).
 *
 * A `connector` binds our client-side handler to a live ACP `Agent`. The default
 * spawns a caller-selected subprocess speaking ACP over stdio and frames it
 * with the official SDK's `ndJsonStream`. Tests inject a fake connector that
 * drives the client handler in-memory, mirroring the Codex adapter's scripted
 * transport.
 *
 * We use `ClientSideConnection` (a persistent `Agent` handle we hold across many
 * prompts) rather than the newer `client().connectWith(stream, op)` helper: that
 * helper scopes the connection to a single callback, which does not fit an
 * `AgentSession` handle whose `submitPrompt()` must drive turns over its whole
 * lifetime. Integration coverage validates this path against real ACP agents.
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, type Agent, type Client } from '@agentclientprotocol/sdk';

export interface AcpAgentConnection {
  /** The live agent connection (initialize / newSession / prompt / loadSession / …). */
  agent: Agent;
  /** Fires when the underlying transport closes (subprocess exit / disconnect). */
  onClose(handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
  /** Tear down the transport (kills the subprocess for the spawn connector). */
  close(): void;
}

/**
 * Wires a client handler to a live ACP agent. `toClient` is the SDK's callback
 * shape: given the `Agent`, return the `Client` handler that processes the
 * agent's inbound requests/notifications (session/update, requestPermission).
 */
export type AcpConnector = (toClient: (agent: Agent) => Client) => AcpAgentConnection;

export interface StdioAcpConnectorOptions {
  /** Agent-specific executable. There is deliberately no protocol-level default. */
  executable: string;
  /** Agent-specific arguments. Defaults to none. */
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawn an explicitly selected ACP agent and speak ND-JSON over stdio. */
export function createStdioAcpConnector(opts: StdioAcpConnectorOptions): AcpConnector {
  return (toClient) => {
    const child = spawn(opts.executable, opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: opts.cwd,
      env: opts.env,
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const agent = new ClientSideConnection(toClient, stream);

    let onCls: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    child.on('exit', (code, signal) => onCls?.({ code, signal }));

    return {
      agent,
      onClose: (handler) => {
        onCls = handler;
      },
      close: () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      },
    };
  };
}
