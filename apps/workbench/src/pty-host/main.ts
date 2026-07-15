/**
 * pty-host — the process that actually owns PTYs (DESIGN §13.1, §22.5 daemon seam).
 *
 * Runs under system Node via the tsx CLI, launched by Electron main. Because it
 * is plain Node (not Electron), node-pty loads against a matching ABI; Electron
 * main stays free of the native module.
 *
 * It is an avocado **IPCSessionHost**: it connects to the UDS socket owned by
 * Electron main (path in CHOPSTICKS_SOCKET) and accepts hub-initiated spawn
 * requests. Each spawn goes through chopsticks' own byte-exact spine
 * (buildAgentEnvironment + spawnPty), whose NativeProcessHandle is adapted to
 * avocado's IPty and wrapped in a LocalPTYSession. The host relays the session's
 * output/exit/resize to the hub; input/resize/kill route back here.
 *
 * Independently of avocado, every session also feeds chopsticks' observation tee
 * (OrderedTerminalDistributor + headless mirror) — the recording / runtime-state
 * layer — so that stays available regardless of the transport in front of it.
 */

import {
  buildAgentEnvironment,
  createHeadlessMirror,
  createTerminalDistributor,
  spawnPty,
  terminateTree,
  type HeadlessMirror,
  type NativeProcessHandle,
  type TerminalDistributor,
} from '@vibecook/chopsticks-node';
import { fakeAgentBin } from '@vibecook/chopsticks-testing';
import { LocalPTYSession, type IPty } from '@vibecook/avocado-sdk/node-pty';
import { createIPCSessionHost, type SpawnConfig } from '@vibecook/avocado-sdk/transport-ipc';
import type { IPTYSession } from '@vibecook/avocado-sdk/types';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Per-session record: the avocado session plus chopsticks' observation layer. */
interface HostSession {
  session: LocalPTYSession;
  handle: NativeProcessHandle;
  distributor: TerminalDistributor;
  mirror: HeadlessMirror;
}

const sessions = new Map<string, HostSession>();

// --- kind resolution (host-side) ------------------------------------------

/**
 * Resolve the wire `command` into a real executable. `kind` shorthands from the
 * renderer arrive as sentinel commands ('shell', 'fake-agent') set by main;
 * everything else is taken literally. Resolution lives here — not in main —
 * because 'fake-agent' needs THIS process's execPath (system Node, the runtime
 * hosting us) and the fakeAgentBin fixture, neither of which Electron main can
 * supply from under the Electron binary.
 */
function resolveSpawn(config: SpawnConfig): { command: string; args: string[] } {
  switch (config.command) {
    case 'shell':
      // Login shell on macOS (Ghostty / Terminal.app); keep args empty elsewhere.
      return {
        command: process.env.SHELL ?? '/bin/zsh',
        args: process.platform === 'darwin' ? ['-l'] : [],
      };
    case 'fake-agent':
      return { command: process.execPath, args: [fakeAgentBin] };
    case 'node':
      // Portable shorthand for the host's own Node binary.
      return { command: process.execPath, args: config.args ?? [] };
    default:
      return { command: config.command, args: config.args ?? [] };
  }
}

// --- IPty adapter over chopsticks' NativeProcessHandle --------------------

/**
 * Adapt a chopsticks NativeProcessHandle to avocado's IPty so a LocalPTYSession
 * can wrap a PTY we spawned. NativeProcessHandle carries no cols/rows, so the
 * adapter tracks geometry itself (LocalPTYSession reads pty.cols/pty.rows at
 * construction). kill() runs chopsticks' terminateTree — the escalation ladder
 * plus process-group sweep — not a bare pty.kill; the session's exit still flows
 * from handle.onExit, so this is fire-and-forget.
 */
function toIPty(handle: NativeProcessHandle, cols: number, rows: number): IPty {
  let curCols = cols;
  let curRows = rows;
  return {
    pid: handle.pid,
    get cols() {
      return curCols;
    },
    get rows() {
      return curRows;
    },
    write(data: string | Buffer): void {
      handle.write(data);
    },
    resize(nextCols: number, nextRows: number): void {
      curCols = nextCols;
      curRows = nextRows;
      handle.resize(nextCols, nextRows);
    },
    kill(): void {
      // Escalation ladder + group sweep; exit is observed via onExit below.
      void terminateTree(handle);
    },
    onData(callback: (data: string | Buffer) => void): { dispose: () => void } {
      const off = handle.onData((bytes) => callback(Buffer.from(bytes)));
      return { dispose: off };
    },
    onExit(callback: (exit: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
      const off = handle.onExit((exit) => callback({ exitCode: exit.exitCode ?? 0, signal: exit.signal ?? undefined }));
      return { dispose: off };
    },
  };
}

// --- spawn handler --------------------------------------------------------

function spawnHandler(config: SpawnConfig): IPTYSession {
  const { command, args } = resolveSpawn(config);
  if (!command) throw new Error('spawn requires a command');
  const cwd = config.cwd ?? process.env.HOME ?? process.cwd();
  const cols = config.cols ?? DEFAULT_COLS;
  const rows = config.rows ?? DEFAULT_ROWS;

  // chopsticks' byte-exact spine: node-pty with encoding:null, curated env.
  const handle = spawnPty({ command, args, cwd, env: buildAgentEnvironment({ allowed: config.env }), cols, rows });
  const session = new LocalPTYSession(toIPty(handle, cols, rows), { command, cwd });

  // Observation tee — chopsticks' recording / runtime-state layer, kept
  // independent of avocado. A second subscriber on the same raw byte stream.
  const distributor = createTerminalDistributor({
    sessionId: session.id,
    onSinkError: (sinkId, err) => process.stderr.write(`[pty-host] sink ${sinkId} error: ${String(err)}\n`),
  });
  const mirror = createHeadlessMirror({ cols, rows });
  distributor.attach(mirror.sink);
  handle.onData((data) => {
    distributor.push(data);
  });

  sessions.set(session.id, { session, handle, distributor, mirror });
  session.on('exit', () => {
    mirror.dispose();
    sessions.delete(session.id);
  });

  return session;
}

// --- host lifecycle -------------------------------------------------------

const socketPath = process.env.CHOPSTICKS_SOCKET;
if (!socketPath) {
  process.stderr.write('[pty-host] CHOPSTICKS_SOCKET not set — cannot connect to hub\n');
  process.exit(1);
}

const host = createIPCSessionHost({ socketPath, spawnHandler, autoRetry: true });
host.on('error', (err) => process.stderr.write(`[pty-host] host error: ${err.message}\n`));
host.on('disconnect', (reason) => process.stderr.write(`[pty-host] disconnected: ${reason}\n`));
void host.connect();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  host.dispose();
  await Promise.allSettled([...sessions.values()].map((s) => terminateTree(s.handle)));
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

process.stdout.write(`[pty-host] ready (pid ${process.pid}, node ${process.version})\n`);
