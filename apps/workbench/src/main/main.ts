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
import { createClaudeSession, type ClaudeSession } from '@vibecook/chopsticks-adapter-claude';
import type { AgentEventEnvelope, SessionRuntimeState } from '@vibecook/chopsticks-core';
import type {
  AgentEventMessage,
  ChunkEvent,
  ClaudeSessionInfo,
  CreateClaudeSessionOptions,
  CreateSessionOptions,
  ExitEvent,
  PromptReceipt,
  SerializedSessionState,
  SessionDescriptor,
  SubmitPromptOptions,
} from '../protocol.js';

// Bundled to CommonJS (dist/main.cjs), the conventional Electron main entry
// format; __dirname / require are the Node-provided CommonJS globals.
declare const __dirname: string;
declare const require: NodeRequire;

const SMOKE = process.argv.includes('--smoke');
const CHUNK_FLUSH_MS = 8;
// One display frame: agent events/state coalesce to at most one push per frame,
// so a burst of hooks can't flood the renderer with per-event IPC.
const AGENT_FLUSH_MS = 16;
// Initial geometry for a Claude PTY; the renderer resizes to the fitted tab as
// soon as its pane has real dimensions (chopsticks:resize on the same id).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// dist/ holds preload.cjs + index.html; appRoot (apps/workbench) is its parent.
const dirname = __dirname;
const appRoot = path.join(dirname, '..');
// Default cwd for Claude sessions: the chopsticks repo root (apps/workbench →
// two levels up). Documented default; the renderer may override per session.
const repoRoot = path.resolve(appRoot, '..', '..');

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

// --- Claude session state -------------------------------------------------
// The driver runs HERE, in Electron main (DESIGN §16): the pty-host stays
// Claude-agnostic. Sessions are keyed by their runtimeSessionId — the same
// namespaced manager id the terminal surface uses — so terminal I/O and agent
// observation share one identity.
const claudeSessions = new Map<string, ClaudeSession>();
let agentEventBatch: AgentEventMessage[] = [];
let agentFlushTimer: NodeJS.Timeout | undefined;

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
  // Exit is taken from the transport's `sessionEnded` for per-connection
  // scoping (manager 'exit' also works since avocado 0.2.2, which fixed the
  // dispose-before-exit race for proxy sessions and put the signal on the wire).
  bridge.on('transportCreated', (_id: string, transport: IPCPTYTransport) => {
    hostTransport = transport;
    resolveTransport(transport);
    transport.on('sessionEnded', (remoteId: string, exitCode: number, signal?: string) => {
      const sessionId = createNamespacedId('ipc', transport.transportId, remoteId);
      forwardExit({ sessionId, exitCode, signal: signal ?? null, reason: classifyReason(exitCode, signal) });
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
  // Tear down agent observation before the transport goes: each dispose() stops
  // its hook bridge + transcript observer and cleans the generated settings file.
  for (const claude of claudeSessions.values()) void claude.dispose().catch(() => undefined);
  claudeSessions.clear();
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

/** Exit classification for renderer display; signal rides session:end since avocado 0.2.2. */
function classifyReason(exitCode: number | null, signal?: string): string {
  if (signal || exitCode === null) return 'signal';
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
  // A Claude session's PTY just ended: tear down observation (bridge + observer)
  // and drop it. The process is already gone, so this is observation cleanup only.
  const claude = claudeSessions.get(exit.sessionId);
  if (claude) {
    claudeSessions.delete(exit.sessionId);
    void claude.dispose().catch(() => undefined);
  }
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

// --- Claude session creation ----------------------------------------------

/**
 * Flatten SessionRuntimeState for the wire: structured clone can carry a Map,
 * but the preload's typed surface models these as arrays, so collapse them to
 * arrays of values here rather than leak Map through the renderer contract.
 */
function serializeState(state: SessionRuntimeState): SerializedSessionState {
  return {
    lifecycle: state.lifecycle,
    activeTurn: state.activeTurn,
    tools: [...state.tools.values()],
    permissions: [...state.permissions.values()],
    subagents: [...state.subagents.values()],
    tasks: [...state.tasks.values()],
    lastAssistantMessage: state.lastAssistantMessage,
    exit: state.exit,
    counters: state.counters,
    lastSequence: state.lastSequence,
    diagnostics: state.diagnostics,
  };
}

function scheduleAgentFlush(): void {
  if (agentFlushTimer) return;
  agentFlushTimer = setTimeout(flushAgentEvents, AGENT_FLUSH_MS);
}

/**
 * Push the coalesced envelope batch, then one fresh state snapshot per session
 * that appeared in it. Events give the renderer the scrolling tail; the state
 * push gives it the reduced view (lifecycle, tools, pending permissions).
 */
function flushAgentEvents(): void {
  if (agentFlushTimer) {
    clearTimeout(agentFlushTimer);
    agentFlushTimer = undefined;
  }
  if (agentEventBatch.length === 0) return;
  const batch = agentEventBatch;
  agentEventBatch = [];
  mainWindow?.webContents.send('chopsticks:agentEvents', batch);
  const touched = new Set(batch.map((m) => m.runtimeSessionId));
  for (const runtimeSessionId of touched) {
    const claude = claudeSessions.get(runtimeSessionId);
    if (!claude) continue;
    mainWindow?.webContents.send('chopsticks:agentState', {
      runtimeSessionId,
      state: serializeState(claude.state()),
      observationLevel: claude.observationLevel(),
    });
  }
}

/**
 * Start a Claude session with the driver in main. `ports.spawn` routes the
 * prepared command through the SAME avocado transport as every other session
 * (so the terminal tab, output fan-out, and reload replay all work unchanged);
 * `ports.write` bypasses the renderer-input path and writes straight to the
 * manager, so injected bytes are never mistaken for a human keystroke.
 */
async function createClaudeSessionForRenderer(opts: CreateClaudeSessionOptions): Promise<ClaudeSessionInfo> {
  const transport = hostTransport ?? (await transportReady);
  const cwd = opts.cwd ?? repoRoot;

  const session = await createClaudeSession({
    cwd,
    title: opts.title,
    ports: {
      spawn: async (prepared) => {
        // prepared.env carries CHOPSTICKS_HOOK_TOKEN; it rides the spawn request's
        // env grants → pty-host buildAgentEnvironment allowlist → Claude's hooks.
        const { sessionId: remoteId } = await transport.requestSpawn({
          command: prepared.command,
          args: prepared.args,
          cwd: prepared.cwd,
          env: prepared.env,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        });
        // Announce precedes the ack, so the proxy session already exists here.
        return { runtimeSessionId: createNamespacedId('ipc', transport.transportId, remoteId) };
      },
      write: (runtimeSessionId, data) => {
        // DIRECT manager write — deliberately NOT the renderer 'chopsticks:write'
        // path, so an injected paste never trips notifyUserInput (user priority).
        manager.write(runtimeSessionId, Buffer.from(data, 'utf8'));
      },
    },
  });

  claudeSessions.set(session.runtimeSessionId, session);
  session.onEvent((envelope: AgentEventEnvelope) => {
    agentEventBatch.push({ runtimeSessionId: session.runtimeSessionId, envelope });
    scheduleAgentFlush();
  });

  const info = manager.getSessionInfo(session.runtimeSessionId);
  if (!info) throw new Error(`claude session ${session.runtimeSessionId} not registered in manager`);
  return { sessionId: session.sessionId, runtimeSessionId: session.runtimeSessionId, descriptor: infoToDescriptor(info) };
}

function registerIpc(): void {
  ipcMain.handle('chopsticks:createSession', (_e, opts: CreateSessionOptions) => createSession(opts));
  ipcMain.handle('chopsticks:createClaudeSession', (_e, opts: CreateClaudeSessionOptions) =>
    createClaudeSessionForRenderer(opts ?? {}),
  );
  ipcMain.handle('chopsticks:submitPrompt', (_e, opts: SubmitPromptOptions): Promise<PromptReceipt> => {
    const claude = claudeSessions.get(opts.runtimeSessionId);
    if (!claude) return Promise.resolve({ status: 'rejected', reason: 'no such claude session' });
    return claude.submitPrompt({ text: opts.text });
  });
  ipcMain.handle('chopsticks:write', (_e, sessionId: string, dataBase64: string) => {
    // User priority (DESIGN §17.2): a real keystroke on a Claude terminal must
    // resolve any in-flight injection as 'uncertain' BEFORE its bytes land.
    claudeSessions.get(sessionId)?.notifyUserInput();
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
