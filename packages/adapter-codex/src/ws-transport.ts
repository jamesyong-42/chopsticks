/**
 * WebSocket-over-UDS transport for the Codex app-server (M5 C6).
 *
 * The app-server's socket transports (unix AND tcp) frame JSON-RPC as
 * WebSocket; only stdio:// is NDJSON (CODEX-SURFACE-FINDINGS §8). For the
 * workbench we run one `codex app-server --listen unix://<sock>` and connect a
 * controller over it — UDS is preferred (no port, filesystem-scoped, not
 * network-exposed). Node's built-in WebSocket is TCP-only, so this is a small
 * hand-rolled WS client (handshake + RFC-6455 framing) exposed as a `Transport`,
 * so `createCodexSession` drives it unchanged via the injected-transport seam.
 *
 * Localhost/UDS needs no auth token (the bearer is for remote/pairing).
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from './app-server-client.js';

// ─── RFC 6455 framing ──────────────────────────────────────────────────────

const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Encode a client frame (client → server frames MUST be masked). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/** Incremental frame decoder: feed bytes, get back whole frames. */
class FrameDecoder {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer): DecodedFrame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b1 = this.buf[1]!;
      const opcode = this.buf[0]! & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buf.length < off + 4) break;
        maskKey = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) break;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) {
        const u = Buffer.alloc(len);
        for (let i = 0; i < len; i++) u[i] = payload[i]! ^ maskKey[i % 4]!;
        payload = u;
      }
      this.buf = this.buf.subarray(off + len);
      frames.push({ opcode, payload });
    }
    return frames;
  }
}

// ─── Transport ─────────────────────────────────────────────────────────────

export interface WsUnixTransportOptions {
  /** Host header value for the upgrade request (cosmetic for UDS). */
  host?: string;
}

/**
 * Connect to a listening `codex app-server` over a unix socket and expose it as
 * a `Transport`. Messages are delivered/sent as already-parsed JSON objects
 * (same contract as the stdio transport). Sends before the handshake completes
 * are queued and flushed on open.
 */
export function wsOverUnixTransport(socketPath: string, opts: WsUnixTransportOptions = {}): Transport {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  let closedEmitted = false;

  const decoder = new FrameDecoder();
  let handshakeDone = false;
  let headerBuf = Buffer.alloc(0);
  let open = false;
  const sendQueue: string[] = [];

  const sock = net.connect(socketPath);
  sock.setNoDelay(true);

  const emitClose = (info: { code: number | null; signal: string | null }): void => {
    if (closedEmitted) return;
    closedEmitted = true;
    onCls?.(info);
  };

  const deliverText = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    onMsg?.(parsed);
  };

  const handleFrames = (chunk: Buffer): void => {
    for (const f of decoder.feed(chunk)) {
      if (f.opcode === OP_TEXT || f.opcode === OP_BINARY) deliverText(f.payload.toString('utf8'));
      else if (f.opcode === OP_PING) sock.write(encodeFrame(OP_PONG, f.payload));
      else if (f.opcode === OP_CLOSE) sock.destroy();
    }
  };

  sock.on('connect', () => {
    const key = crypto.randomBytes(16).toString('base64');
    sock.write(
      `GET / HTTP/1.1\r\n` +
        `Host: ${opts.host ?? 'localhost'}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    );
  });

  sock.on('data', (chunk) => {
    if (!handshakeDone) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const statusLine = headerBuf.subarray(0, headerBuf.indexOf('\r\n')).toString();
      if (!statusLine.includes('101')) {
        sock.destroy(new Error(`app-server WS handshake failed: ${statusLine}`));
        return;
      }
      handshakeDone = true;
      open = true;
      const rest = headerBuf.subarray(idx + 4);
      headerBuf = Buffer.alloc(0);
      for (const q of sendQueue) sock.write(encodeFrame(OP_TEXT, Buffer.from(q, 'utf8')));
      sendQueue.length = 0;
      if (rest.length) handleFrames(rest);
      return;
    }
    handleFrames(chunk);
  });

  sock.on('close', () => emitClose({ code: null, signal: null }));
  sock.on('error', () => emitClose({ code: null, signal: null }));

  return {
    send: (message) => {
      const s = JSON.stringify(message);
      if (open) sock.write(encodeFrame(OP_TEXT, Buffer.from(s, 'utf8')));
      else sendQueue.push(s);
    },
    onMessage: (h) => {
      onMsg = h;
    },
    onClose: (h) => {
      onCls = h;
    },
    close: () => {
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

// ─── app-server process ──────────────────────────────────────────────────────

let sockCounter = 0;

export interface AppServerHandle {
  /** The unix socket the app-server is listening on. */
  socketPath: string;
  process: ChildProcess;
  /** Resolves once the socket file exists (or rejects on timeout / early exit). */
  ready(timeoutMs?: number): Promise<void>;
  /** SIGTERM the app-server. */
  dispose(): void;
}

/**
 * Spawn `codex app-server --listen unix://<sock>`. The socket path defaults to a
 * fresh file under the REAL temp dir (macOS `/tmp` is a symlink the app-server's
 * lstat rejects — CODEX-SURFACE-FINDINGS §8).
 */
export function spawnAppServer(opts?: { executable?: string; socketPath?: string }): AppServerHandle {
  const realTmp = realpathSync(tmpdir());
  const socketPath = opts?.socketPath ?? join(realTmp, `chopsticks-codex-${process.pid}-${sockCounter++}.sock`);
  const child = spawn(opts?.executable ?? 'codex', ['app-server', '--listen', `unix://${socketPath}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  return {
    socketPath,
    process: child,
    ready: (timeoutMs = 8000) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        let exited = false;
        child.once('exit', (code) => {
          exited = true;
          reject(new Error(`app-server exited before ready (code ${code})`));
        });
        const tick = (): void => {
          if (exited) return;
          if (existsSync(socketPath)) return resolve();
          if (Date.now() - t0 > timeoutMs) return reject(new Error('app-server socket not ready in time'));
          setTimeout(tick, 100);
        };
        tick();
      }),
    dispose: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}
