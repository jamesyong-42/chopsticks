/**
 * Electron main process (DESIGN §13.1, §23.1).
 *
 * Owns the pty-host child, the session registry, and the IPC surface mirroring
 * the wire protocol. It never imports node-pty: all PTY work lives in the child.
 * Chunk/exit frames from the child are batched onto an ~8 ms timer before being
 * forwarded to the focused window, keeping IPC volume sane under output floods.
 *
 * `--smoke` runs the acceptance path headlessly: spawn /bin/echo, observe its
 * output chunk and exit, print SMOKE OK / exit 0, or fail within 20 s.
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { ChunkEvent, CreateSessionOptions, ExitEvent, SpawnRequest } from '../protocol.js';
import { PtyHostClient } from './pty-host-client.js';

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

let host: PtyHostClient | undefined;
let mainWindow: BrowserWindow | undefined;
/** Internal fan-out so smoke mode can observe frames without a window. */
const hostEvents = new EventEmitter();
let chunkBatch: ChunkEvent[] = [];
let flushTimer: NodeJS.Timeout | undefined;

function ensureHost(): PtyHostClient {
  if (host) return host;
  host = new PtyHostClient({
    nodeBin: process.env.CHOPSTICKS_NODE_BIN ?? 'node',
    tsxCli: resolveTsxCli(),
    entry: path.join(appRoot, 'src', 'pty-host', 'main.ts'),
    cwd: appRoot,
  });
  host.on('chunk', (chunk) => {
    hostEvents.emit('chunk', chunk);
    chunkBatch.push(chunk);
    scheduleFlush();
  });
  host.on('exit', (exit) => {
    hostEvents.emit('exit', exit);
    flushChunks();
    mainWindow?.webContents.send('chopsticks:exit', exit satisfies ExitEvent);
  });
  return host;
}

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

/** Renderer options → wire spawn request (paths for `kind` resolve host-side). */
function toSpawnRequest(opts: CreateSessionOptions): Omit<SpawnRequest, 'id' | 'op'> {
  return { kind: opts.kind, command: opts.command, args: opts.args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows };
}

function registerIpc(): void {
  ipcMain.handle('chopsticks:createSession', (_e, opts: CreateSessionOptions) =>
    ensureHost().spawnSession(toSpawnRequest(opts)),
  );
  ipcMain.handle('chopsticks:write', (_e, sessionId: string, dataBase64: string) =>
    ensureHost().write(sessionId, dataBase64),
  );
  ipcMain.handle('chopsticks:resize', (_e, sessionId: string, cols: number, rows: number) =>
    ensureHost().resize(sessionId, cols, rows),
  );
  ipcMain.handle('chopsticks:terminate', (_e, sessionId: string) => ensureHost().terminate(sessionId));
  ipcMain.handle('chopsticks:replay', (_e, sessionId: string, afterSequence: number) =>
    ensureHost().replay(sessionId, afterSequence),
  );
  ipcMain.handle('chopsticks:list', () => ensureHost().list());
}

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
    app.exit(1);
  };
  const timeout = setTimeout(() => fail('timed out after 20s'), 20_000);

  try {
    const client = ensureHost();
    let sawText = false;
    let sawExit = false;
    let acc = '';
    const settle = (): void => {
      if (sawText && sawExit) {
        clearTimeout(timeout);
        console.log('SMOKE OK');
        app.exit(0);
      }
    };
    const session = await client.spawnSession({
      command: '/bin/echo',
      args: ['chopsticks-smoke-ok'],
      cols: 80,
      rows: 24,
    });
    hostEvents.on('chunk', (chunk: ChunkEvent) => {
      if (chunk.sessionId !== session.sessionId) return;
      acc += Buffer.from(chunk.dataBase64, 'base64').toString('utf8');
      if (acc.includes('chopsticks-smoke-ok')) sawText = true;
      settle();
    });
    hostEvents.on('exit', (exit: ExitEvent) => {
      if (exit.sessionId !== session.sessionId) return;
      sawExit = true;
      settle();
    });
  } catch (err) {
    clearTimeout(timeout);
    fail(err instanceof Error ? err.message : String(err));
  }
}

// --- lifecycle ------------------------------------------------------------

void app.whenReady().then(() => {
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

app.on('before-quit', () => host?.dispose());
