/**
 * Electron main process (DESIGN §13.1, §23.1) — now the avocado **hub**.
 *
 * Main owns a UDSServer + PTYSessionManager + PTYIPCBridge. The pty-host child
 * (system Node via tsx) connects back as an IPCSessionHost over a per-instance
 * Unix socket, and every PTY it spawns surfaces here as a ProxyPTYSession. Main
 * never imports node-pty (nor chopsticks-node): all PTY work lives in the child.
 *
 * The renderer-facing IPC surface (createSession/write/resize/terminate/replay/
 * list, chunk/exit pushes) is reimplemented on top of the manager, so the
 * preload and renderer stay essentially unchanged. Session ids handed to the
 * renderer are the manager's namespaced ids (`ipc|<transportId>|<sessionId>`),
 * treated as opaque strings there.
 *
 * `--smoke` runs the acceptance path headlessly: requestSpawn /bin/echo, observe
 * its output + exit through hub events, print SMOKE OK / exit 0, or fail in 20 s.
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  createNamespacedId,
  createProxyPTYSession,
  createPTYSessionManager,
  type PTYSessionManager,
  type PTYSessionState,
  type SessionOutputEvent,
} from '@vibecook/avocado-sdk';
import {
  createPTYIPCBridge,
  createUDSServer,
  type IPCPTYTransport,
  type IPTYIPCBridge,
  type UDSServer,
} from '@vibecook/avocado-sdk/transport-ipc';
import type { ChunkEvent, CreateSessionOptions, ExitEvent, SessionDescriptor } from '../protocol.js';

// Bundled to CommonJS (dist/main.cjs), the conventional Electron main entry
// format; __dirname / require are the Node-provided CommonJS globals.
declare const __dirname: string;
declare const require: NodeRequire;

const SMOKE = process.argv.includes('--smoke');
const CHUNK_FLUSH_MS = 8;

// dist/ holds preload.cjs + index.html; appRoot (apps/workbench) is its parent.
const dirname = __dirname;
const appRoot = path.join(dirname, '..');

/** tsx CLI: run as `node <cli> <entry>` so the pty-host executes TS directly. */
function resolveTsxCli(): string {
  for (const spec of ['tsx/cli', 'tsx/dist/cli.mjs']) {
    try {
      return require.resolve(spec);
    } catch {
      /* try next */
    }
  }
  throw new Error('cannot resolve the tsx CLI; is tsx installed in apps/workbench?');
}

// --- hub state ------------------------------------------------------------

const manager: PTYSessionManager = createPTYSessionManager();
const server: UDSServer = createUDSServer();
// normalizeOutput MUST be false: byte-exact TUI mirroring — any rewrite corrupts
// cursor-addressed full-screen apps.
const bridge: IPTYIPCBridge = createPTYIPCBridge(manager, { transport: { normalizeOutput: false } });

let mainWindow: BrowserWindow | undefined;
let ptyHost: ChildProcess | undefined;
let socketPath: string | undefined;

/** The single session-host transport (the pty-host child). */
let hostTransport: IPCPTYTransport | undefined;
let resolveTransport!: (t: IPCPTYTransport) => void;
const transportReady = new Promise<IPCPTYTransport>((res) => {
  resolveTransport = res;
});

/** Internal fan-out so smoke mode can observe hub events without a window. */
const hubEvents = new EventEmitter();
let chunkBatch: ChunkEvent[] = [];
let flushTimer: NodeJS.Timeout | undefined;

// --- hub lifecycle --------------------------------------------------------

function startHub(): void {
  const socketDir = path.join(os.homedir(), '.chopsticks');
  // 0700: only the user may reach the control socket.
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  socketPath = path.join(socketDir, `workbench-${process.pid}.sock`);

  manager.setProxySessionFactory(createProxyPTYSession);

  // Output fan-out: manager 'output' → ~8 ms batch → focused window.
  manager.on('output', (e: SessionOutputEvent) => {
    hubEvents.emit('output', e);
    chunkBatch.push({ sessionId: e.sessionId, dataBase64: e.data.toString('base64') });
    scheduleFlush();
  });

  // Exactly one session host connects; capture its transport and its exits.
  // Exit is taken from the transport's `sessionEnded` (carries the exit code and
  // fires reliably) rather than manager 'exit', which the manager suppresses for
  // proxy sessions by disposing them first.
  bridge.on('transportCreated', (_id: string, transport: IPCPTYTransport) => {
    hostTransport = transport;
    resolveTransport(transport);
    transport.on('sessionEnded', (remoteId: string, exitCode: number) => {
      const sessionId = createNamespacedId('ipc', transport.transportId, remoteId);
      forwardExit({ sessionId, exitCode, signal: null, reason: classifyReason(exitCode) });
    });
  });

  // Server must be listening before the child tries to connect.
  server.start({ socketPath });
  bridge.initialize(server);
  spawnPtyHost(socketPath);
}

/** Spawn the pty-host child under system Node via tsx, pointed at the socket. */
function spawnPtyHost(socket: string): void {
  ptyHost = spawn(process.env.CHOPSTICKS_NODE_BIN ?? 'node', [resolveTsxCli(), path.join(appRoot, 'src', 'pty-host', 'main.ts')], {
    cwd: appRoot,
    // No stdio protocol anymore (avocado owns the socket); inherit for diagnostics.
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, CHOPSTICKS_SOCKET: socket },
  });
  ptyHost.on('exit', (code) => {
    process.stderr.write(`[main] pty-host exited (code ${code ?? 'null'})\n`);
  });
}

let hubDisposed = false;
function disposeHub(): void {
  if (hubDisposed) return;
  hubDisposed = true;
  ptyHost?.kill('SIGTERM');
  ptyHost = undefined;
  bridge.dispose();
  manager.dispose();
  server.dispose(); // unlinks the socket file
}

/** app.exit() skips the normal quit lifecycle, so tear the hub down explicitly first. */
function exitAfterCleanup(code: number): void {
  disposeHub();
  app.exit(code);
}

/** Coarse exit classification for renderer display (signal is not on the wire). */
function classifyReason(exitCode: number | null): string {
  if (exitCode === null) return 'signal';
  return exitCode === 0 ? 'completed' : 'crash';
}

// --- output batching ------------------------------------------------------

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS);
}

function flushChunks(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (chunkBatch.length === 0) return;
  const batch = chunkBatch;
  chunkBatch = [];
  mainWindow?.webContents.send('chopsticks:chunks', batch);
}

function forwardExit(exit: ExitEvent): void {
  hubEvents.emit('exit', exit);
  flushChunks();
  mainWindow?.webContents.send('chopsticks:exit', exit);
}

// --- session creation -----------------------------------------------------

/** Renderer options → avocado spawn config. `kind` becomes a sentinel command the host resolves. */
function toSpawnConfig(opts: CreateSessionOptions): {
  command: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
} {
  const base = { cwd: opts.cwd, cols: opts.cols, rows: opts.rows };
  if (opts.kind === 'shell') return { command: 'shell', ...base };
  if (opts.kind === 'fake-agent') return { command: 'fake-agent', ...base };
  return { command: opts.command ?? '', args: opts.args, ...base };
}

function infoToDescriptor(info: PTYSessionState): SessionDescriptor {
  return {
    sessionId: info.id,
    pid: info.pid,
    command: info.command,
    cwd: info.cwd,
    cols: info.cols,
    rows: info.rows,
    exited: !info.isRunning,
  };
}

async function createSession(opts: CreateSessionOptions): Promise<SessionDescriptor> {
  const transport = hostTransport ?? (await transportReady);
  const { sessionId: remoteId } = await transport.requestSpawn(toSpawnConfig(opts));
  // The host announces before it acknowledges, so the proxy session already
  // exists in the manager under this namespaced id.
  const sessionId = createNamespacedId('ipc', transport.transportId, remoteId);
  const info = manager.getSessionInfo(sessionId);
  if (!info) throw new Error(`spawned session ${sessionId} not registered in manager`);
  return infoToDescriptor(info);
}

function registerIpc(): void {
  ipcMain.handle('chopsticks:createSession', (_e, opts: CreateSessionOptions) => createSession(opts));
  ipcMain.handle('chopsticks:write', (_e, sessionId: string, dataBase64: string) => {
    manager.write(sessionId, Buffer.from(dataBase64, 'base64'));
  });
  ipcMain.handle('chopsticks:resize', (_e, sessionId: string, cols: number, rows: number) => {
    manager.resize(sessionId, cols, rows);
  });
  ipcMain.handle('chopsticks:terminate', (_e, sessionId: string) => {
    manager.kill(sessionId);
  });
  ipcMain.handle('chopsticks:replay', (_e, sessionId: string) => {
    // Reload recovery: the proxy session's CircularOutputBuffer is the source.
    const buffer = manager.getOutputBuffer(sessionId);
    return { snapshotBase64: buffer ? buffer.toString('base64') : '' };
  });
  ipcMain.handle('chopsticks:list', () => manager.getAllSessionInfos().map(infoToDescriptor));
}

// --- window ---------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'chopsticks workbench',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  void mainWindow.loadFile(path.join(dirname, 'index.html'));
}

// --- smoke acceptance path ------------------------------------------------

async function runSmoke(): Promise<void> {
  const fail = (reason: string): void => {
    console.error(`SMOKE FAIL: ${reason}`);
    exitAfterCleanup(1);
  };
  const timeout = setTimeout(() => fail('timed out after 20s'), 20_000);

  try {
    const transport = await transportReady;

    // Buffer everything by session id and resolve once we know the spawned id —
    // echo can finish before requestSpawn's promise settles.
    let expectedId: string | undefined;
    let sawText = false;
    const text = new Map<string, string>();
    const exited = new Set<string>();
    const settle = (): void => {
      if (!expectedId) return;
      if ((text.get(expectedId) ?? '').includes('chopsticks-smoke-ok')) sawText = true;
      if (sawText && exited.has(expectedId)) {
        clearTimeout(timeout);
        console.log('SMOKE OK');
        exitAfterCleanup(0);
      }
    };

    hubEvents.on('output', (e: SessionOutputEvent) => {
      text.set(e.sessionId, (text.get(e.sessionId) ?? '') + e.data.toString('utf8'));
      settle();
    });
    hubEvents.on('exit', (e: ExitEvent) => {
      exited.add(e.sessionId);
      settle();
    });

    const { sessionId: remoteId } = await transport.requestSpawn({
      command: '/bin/echo',
      args: ['chopsticks-smoke-ok'],
      cols: 80,
      rows: 24,
    });
    expectedId = createNamespacedId('ipc', transport.transportId, remoteId);
    settle();
  } catch (err) {
    clearTimeout(timeout);
    fail(err instanceof Error ? err.message : String(err));
  }
}

// --- lifecycle ------------------------------------------------------------

void app.whenReady().then(() => {
  startHub();
  registerIpc();
  if (SMOKE) {
    void runSmoke();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => disposeHub());
