/**
 * Hook bridge — loopback HTTP endpoint receiving Claude Code hook POSTs
 * (DESIGN §16.4/§16.6; transport verified live in Phase 0 run F).
 *
 * Rules enforced here, per §16.6:
 * - binds loopback only, ephemeral port by default
 * - authenticates every request (bearer token, constant-time compare)
 * - limits request body size; applies a hard socket timeout
 * - acknowledges observational events IMMEDIATELY (Claude's hook timeout is
 *   seconds — nothing downstream of the 200 may block the agent)
 * - parses JSON safely; malformed events are logged to the sink, never thrown
 * - rejects events for sessions this bridge does not own
 *
 * Payloads carry no timestamps — `receivedAt` is stamped here and is the
 * ingestion clock for envelope stamping upstream.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

export interface NativeHookEnvelope {
  requestId: string;
  receivedAt: string;
  body: Record<string, unknown>;
}

export interface HookBridgeOptions {
  /** Explicit session allow-list; events for other sessions get 403. */
  allowSession: (sessionId: string) => boolean;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
  onProtocolError?: (kind: 'auth' | 'too-large' | 'malformed' | 'unknown-session', detail: string) => void;
}

export interface HookBridge {
  readonly token: string;
  /** http://127.0.0.1:<port>/hooks — available after start(). */
  endpoint(): string;
  start(): Promise<void>;
  onEvent(listener: (envelope: NativeHookEnvelope) => void): () => void;
  dispose(): Promise<void>;
}

const HOST = '127.0.0.1';
const DEFAULT_MAX_BODY = 256 * 1024;

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function createHookBridge(options: HookBridgeOptions): HookBridge {
  const token = options.token ?? randomUUID();
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const listeners = new Set<(e: NativeHookEnvelope) => void>();
  let server: Server | null = null;
  let port = 0;

  function reject(
    res: ServerResponse,
    status: number,
    kind: 'auth' | 'too-large' | 'malformed' | 'unknown-session',
    detail: string,
  ): void {
    options.onProtocolError?.(kind, detail);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (!tokenMatches(req.headers.authorization, token)) {
      reject(res, 401, 'auth', 'bad or missing bearer token');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        overflowed = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('close', () => {
      if (overflowed) options.onProtocolError?.('too-large', `body exceeded ${maxBody} bytes`);
    });

    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch (err) {
        reject(res, 400, 'malformed', err instanceof Error ? err.message : String(err));
        return;
      }

      const sessionId = body.session_id;
      if (typeof sessionId !== 'string' || !options.allowSession(sessionId)) {
        reject(res, 403, 'unknown-session', String(sessionId ?? 'missing session_id'));
        return;
      }

      // Ack before fan-out: listeners must never hold Claude's hook open.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');

      const envelope: NativeHookEnvelope = {
        requestId: randomUUID(),
        receivedAt: new Date().toISOString(),
        body,
      };
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch {
          // A misbehaving consumer must not affect the agent-facing endpoint.
        }
      }
    });
  }

  return {
    token,
    endpoint: () => `http://${HOST}:${port}/hooks`,

    start(): Promise<void> {
      if (server) return Promise.resolve();
      return new Promise((resolve, reject_) => {
        server = createServer(handle);
        server.on('error', reject_);
        // Hooks are tiny POSTs; anything lingering is a stuck client.
        server.requestTimeout = 10_000;
        server.listen(options.port ?? 0, HOST, () => {
          const address = server!.address();
          port = typeof address === 'object' && address ? address.port : 0;
          resolve();
        });
      });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): Promise<void> {
      listeners.clear();
      const s = server;
      server = null;
      if (!s) return Promise.resolve();
      return new Promise((resolve) => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
    },
  };
}
