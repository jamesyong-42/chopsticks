/**
 * PTY transport (DESIGN §11 NativeProcessHandle, §16.2 spawn path).
 *
 * node-pty is spawned with encoding:null so output arrives as raw bytes —
 * PTY output is visually authoritative (ADR-004) and recordings must be
 * byte-exact, including deliberately malformed UTF-8.
 */

import { spawn as ptySpawn } from 'node-pty';

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Built via buildAgentEnvironment — never the full parent env (§23.2). */
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  termName?: string;
}

export interface ProcessExit {
  exitCode: number | null;
  signal?: number | null;
}

export interface NativeProcessHandle {
  readonly pid: number;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exit: ProcessExit) => void): () => void;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<ProcessExit>;
}

export function spawnPty(options: PtySpawnOptions): NativeProcessHandle {
  const pty = ptySpawn(options.command, options.args ?? [], {
    name: options.termName ?? 'xterm-256color',
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd,
    env: options.env,
    // Typed as string in node-pty, but null switches onData to raw Buffers.
    encoding: null as unknown as string,
  });

  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(exit: ProcessExit) => void>();
  let resolveExited: (exit: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExited = resolve;
  });

  pty.onData((data) => {
    const bytes: Uint8Array = typeof data === 'string' ? Buffer.from(data, 'utf8') : (data as unknown as Buffer);
    for (const listener of dataListeners) listener(bytes);
  });

  pty.onExit(({ exitCode, signal }) => {
    const exit: ProcessExit = { exitCode: exitCode ?? null, signal: signal ?? null };
    resolveExited(exit);
    for (const listener of exitListeners) listener(exit);
  });

  return {
    pid: pty.pid,
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    write(data) {
      // node-pty's typing says string, but its socket accepts Buffers as-is;
      // Buffer passthrough avoids double-encoding binary input reports.
      pty.write(typeof data === 'string' ? data : (Buffer.from(data) as unknown as string));
    },
    resize(cols, rows) {
      pty.resize(cols, rows);
    },
    kill(signal) {
      pty.kill(signal);
    },
    exited,
  };
}
