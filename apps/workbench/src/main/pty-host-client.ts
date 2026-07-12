/**
 * pty-host client (Electron main side).
 *
 * Owns the child process and the NDJSON transport. Correlates each request to
 * its response by numeric id and re-emits chunk/exit frames as events. Knows
 * nothing about Electron — this is the seam that a future external daemon
 * (DESIGN §22.5) slots into unchanged.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import {
  isHostEvent,
  type ChunkEvent,
  type ExitEvent,
  type HostMessage,
  type HostRequestBody,
  type HostResponse,
  type ListResult,
  type ReplayResult,
  type SessionDescriptor,
  type SpawnRequest,
  type SpawnResult,
  type TerminateResult,
} from '../protocol.js';

export interface PtyHostSpawnConfig {
  /** System Node binary (never Electron's process.execPath). */
  nodeBin: string;
  /** Path to the tsx CLI entry, run as `node <tsxCli> <entry>`. */
  tsxCli: string;
  /** pty-host source entry (TypeScript, executed through tsx). */
  entry: string;
  /** Working dir for the child so workspace package resolution succeeds. */
  cwd: string;
}

type Pending = { resolve: (value: HostResponse) => void; reject: (err: Error) => void };

export interface PtyHostClient extends EventEmitter {
  on(event: 'chunk', listener: (chunk: ChunkEvent) => void): this;
  on(event: 'exit', listener: (exit: ExitEvent) => void): this;
  on(event: 'host-exit', listener: (code: number | null) => void): this;
}

export class PtyHostClient extends EventEmitter {
  // stderr is inherited (null stream), so stdin/stdout are the piped ends.
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private inbox = '';

  constructor(config: PtyHostSpawnConfig) {
    super();
    // stderr inherited so pty-host diagnostics surface in the launching terminal.
    this.child = spawn(config.nodeBin, [config.tsxCli, config.entry], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => this.onStdout(data));
    this.child.on('exit', (code) => {
      const err = new Error('pty-host exited');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.emit('host-exit', code);
    });
  }

  private onStdout(data: string): void {
    this.inbox += data;
    for (let nl = this.inbox.indexOf('\n'); nl !== -1; nl = this.inbox.indexOf('\n')) {
      const line = this.inbox.slice(0, nl);
      this.inbox = this.inbox.slice(nl + 1);
      if (!line.trim()) continue;
      let message: HostMessage;
      try {
        message = JSON.parse(line) as HostMessage;
      } catch {
        continue;
      }
      if (isHostEvent(message)) {
        this.emit(message.event, message);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  private request(body: HostRequestBody): Promise<HostResponse> {
    const id = this.nextId++;
    return new Promise<HostResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  private async ok<T>(body: HostRequestBody): Promise<T> {
    const response = await this.request(body);
    if (!response.ok) throw new Error(response.error);
    return response as unknown as T;
  }

  spawnSession(request: Omit<SpawnRequest, 'id' | 'op'>): Promise<SessionDescriptor> {
    return this.ok<SpawnResult>({ op: 'spawn', ...request }).then((r) => r.session);
  }
  write(sessionId: string, dataBase64: string): Promise<void> {
    return this.ok({ op: 'write', sessionId, dataBase64 });
  }
  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    return this.ok({ op: 'resize', sessionId, cols, rows });
  }
  terminate(sessionId: string): Promise<TerminateResult> {
    return this.ok<TerminateResult>({ op: 'terminate', sessionId });
  }
  replay(sessionId: string, afterSequence: number): Promise<ReplayResult> {
    return this.ok<ReplayResult>({ op: 'replay', sessionId, afterSequence });
  }
  list(): Promise<SessionDescriptor[]> {
    return this.ok<ListResult>({ op: 'list' }).then((r) => r.sessions);
  }

  dispose(): void {
    this.child.stdin.end();
  }
}
