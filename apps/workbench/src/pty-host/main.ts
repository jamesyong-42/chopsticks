/**
 * pty-host — the process that actually owns PTYs (DESIGN §13.1, §22.5 daemon seam).
 *
 * Runs under system Node via the tsx CLI, launched by Electron main. Because it
 * is plain Node (not Electron), node-pty loads against a matching ABI; Electron
 * main stays free of the native module. It imports the workspace terminal spine
 * directly and translates the NDJSON protocol (../protocol.ts) into spawnPty /
 * distributor / terminateTree calls.
 *
 * stdout is reserved for protocol frames only — terminal bytes leave as base64
 * `chunk` events, never as raw writes. Diagnostics go to stderr.
 */

import { randomUUID } from 'node:crypto';
import {
  buildAgentEnvironment,
  classifyExit,
  createTerminalDistributor,
  spawnPty,
  terminateTree,
  type NativeProcessHandle,
  type TerminalChunk,
  type TerminalDistributor,
} from '@vibecook/chopsticks-node';
import { fakeAgentBin } from '@vibecook/chopsticks-testing';
import type {
  HostMessage,
  HostRequest,
  HostResponse,
  SessionDescriptor,
  SessionKind,
  SpawnRequest,
} from '../protocol.js';

/** Main's forwarding sink is required (§12.4): never dropped, bounded by 8 MiB. */
const MAIN_SINK_MAX_QUEUE_BYTES = 8 * 1024 * 1024;

interface Session {
  descriptor: SessionDescriptor;
  handle: NativeProcessHandle;
  distributor: TerminalDistributor;
  /** Set when a terminate request drove the exit, so the reason is user-terminated. */
  terminateRequested: boolean;
}

const sessions = new Map<string, Session>();

// --- stdout framing with backpressure -------------------------------------

/** Write one NDJSON frame; resolves once the pipe has accepted it (drain-aware). */
function send(message: HostMessage): Promise<void> {
  const line = `${JSON.stringify(message)}\n`;
  return new Promise((resolve) => {
    const flushed = process.stdout.write(line, () => resolve());
    // write() already queued it; the callback fires on flush either way.
    void flushed;
  });
}

function fail(id: number, error: unknown): Promise<void> {
  const response: HostResponse = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  return send(response);
}

// --- session lifecycle ----------------------------------------------------

function expandKind(kind: SessionKind): { command: string; args: string[] } {
  switch (kind) {
    case 'shell':
      return { command: process.env.SHELL ?? '/bin/zsh', args: [] };
    case 'fake-agent':
      // process.execPath here is system Node — the exact runtime hosting us.
      return { command: process.execPath, args: [fakeAgentBin] };
  }
}

function spawnSession(request: SpawnRequest): SessionDescriptor {
  const resolved = request.kind
    ? expandKind(request.kind)
    : { command: request.command ?? '', args: request.args ?? [] };
  if (!resolved.command) throw new Error('spawn requires either `kind` or `command`');
  // 'node' is portable shorthand for the host's own Node binary.
  const command = resolved.command === 'node' ? process.execPath : resolved.command;
  const cwd = request.cwd ?? process.env.HOME ?? process.cwd();
  const cols = request.cols;
  const rows = request.rows;

  const handle = spawnPty({ command, args: resolved.args, cwd, env: buildAgentEnvironment(), cols, rows });
  const sessionId = randomUUID();

  const distributor = createTerminalDistributor({
    sessionId,
    onRequiredHighWater: (sinkId, queuedBytes) =>
      process.stderr.write(`[pty-host] sink ${sinkId} lagging: ${queuedBytes} bytes queued\n`),
    onSinkError: (sinkId, err) => process.stderr.write(`[pty-host] sink ${sinkId} error: ${String(err)}\n`),
  });

  // Required sink: forward every ordered chunk to main; awaiting the send gives
  // the drain loop real backpressure without ever blocking the PTY read.
  distributor.attach({
    id: `main:${sessionId}`,
    policy: { type: 'required', maxQueueBytes: MAIN_SINK_MAX_QUEUE_BYTES },
    write(chunk: TerminalChunk) {
      return send({
        event: 'chunk',
        sessionId,
        sequence: chunk.sequence,
        dataBase64: Buffer.from(chunk.data).toString('base64'),
      });
    },
  });

  const descriptor: SessionDescriptor = {
    sessionId,
    pid: handle.pid,
    command,
    args: resolved.args,
    cwd,
    cols,
    rows,
    lastSequence: 0,
    exited: false,
  };
  const session: Session = { descriptor, handle, distributor, terminateRequested: false };
  sessions.set(sessionId, session);

  handle.onData((data) => {
    const chunk = distributor.push(data);
    descriptor.lastSequence = chunk.sequence;
  });
  handle.onExit((exit) => {
    descriptor.exited = true;
    void send({
      event: 'exit',
      sessionId,
      exitCode: exit.exitCode,
      signal: exit.signal ?? null,
      reason: classifyExit({ exit, requestedBy: session.terminateRequested ? 'user' : null }),
    });
  });

  return descriptor;
}

// --- request dispatch -----------------------------------------------------

async function handleRequest(request: HostRequest): Promise<void> {
  switch (request.op) {
    case 'spawn': {
      const descriptor = spawnSession(request);
      await send({ id: request.id, ok: true, session: descriptor });
      return;
    }
    case 'write': {
      const session = sessions.get(request.sessionId);
      if (!session) return void (await fail(request.id, `unknown session ${request.sessionId}`));
      session.handle.write(Buffer.from(request.dataBase64, 'base64'));
      await send({ id: request.id, ok: true });
      return;
    }
    case 'resize': {
      const session = sessions.get(request.sessionId);
      if (!session) return void (await fail(request.id, `unknown session ${request.sessionId}`));
      session.handle.resize(request.cols, request.rows);
      session.descriptor.cols = request.cols;
      session.descriptor.rows = request.rows;
      await send({ id: request.id, ok: true });
      return;
    }
    case 'terminate': {
      const session = sessions.get(request.sessionId);
      if (!session) return void (await fail(request.id, `unknown session ${request.sessionId}`));
      session.terminateRequested = true;
      const exit = await terminateTree(session.handle);
      await send({ id: request.id, ok: true, exitCode: exit.exitCode, signal: exit.signal ?? null });
      return;
    }
    case 'replay': {
      const session = sessions.get(request.sessionId);
      if (!session) return void (await fail(request.id, `unknown session ${request.sessionId}`));
      const replay = session.distributor.replayAfter(request.afterSequence);
      await send({
        id: request.id,
        ok: true,
        chunks: replay.chunks.map((c) => ({
          sequence: c.sequence,
          dataBase64: Buffer.from(c.data).toString('base64'),
        })),
        complete: replay.complete,
      });
      return;
    }
    case 'list': {
      await send({ id: request.id, ok: true, sessions: [...sessions.values()].map((s) => s.descriptor) });
      return;
    }
  }
}

// --- stdin NDJSON reader --------------------------------------------------

let inbox = '';
process.stdin.on('data', (chunk: Buffer) => {
  inbox += chunk.toString('utf8');
  for (let nl = inbox.indexOf('\n'); nl !== -1; nl = inbox.indexOf('\n')) {
    const line = inbox.slice(0, nl);
    inbox = inbox.slice(nl + 1);
    if (!line.trim()) continue;
    let request: HostRequest;
    try {
      request = JSON.parse(line) as HostRequest;
    } catch (err) {
      process.stderr.write(`[pty-host] dropping unparseable frame: ${String(err)}\n`);
      continue;
    }
    void handleRequest(request).catch((err) => void fail(request.id, err));
  }
});

async function shutdown(): Promise<void> {
  await Promise.allSettled(
    [...sessions.values()].map((s) => (s.descriptor.exited ? Promise.resolve() : terminateTree(s.handle))),
  );
  process.exit(0);
}

// Main gone (pipe closed) → sweep owned trees so nothing is orphaned.
process.stdin.on('end', () => void shutdown());
process.stdin.on('close', () => void shutdown());

process.stderr.write(`[pty-host] ready (pid ${process.pid}, node ${process.version})\n`);
