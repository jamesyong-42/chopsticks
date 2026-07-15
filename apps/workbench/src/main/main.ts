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
import { app, BrowserWindow, clipboard, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';
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
import { createActionRecorder, type ActionRecorder } from '@vibecook/chopsticks-record';
import type { AgentHost, SessionRuntimeState } from '@vibecook/chopsticks-core';
import { createBuiltinAgentRuntime, type AgentRuntime, type AgentWorkspaceFinal } from '@vibecook/chopsticks-runtime';
import type {
  AgentSessionInfo,
  ChunkEvent,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
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
// Initial geometry for an agent PTY; the renderer resizes to the fitted tab as
// soon as its pane has real dimensions (chopsticks:resize on the same id).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// dist/ holds preload.cjs + index.html; appRoot (apps/workbench) is its parent.
const dirname = __dirname;
const appRoot = path.join(dirname, '..');
// Default cwd for agent sessions: the chopsticks repo root (apps/workbench →
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

// The terminal capability the unified runtime lends to its providers.
// (core `AgentHost`). spawnTerminal routes every agent PTY through the SAME
// avocado transport as any other session; writeTerminal is a DIRECT manager
// write (never the renderer input path), so an injected paste is never mistaken
// for a human keystroke (user-priority §17.2).
const host: AgentHost = {
  async spawnTerminal(spec) {
    const transport = hostTransport ?? (await transportReady);
    const { sessionId: remoteId } = await transport.requestSpawn({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
    });
    return { runtimeSessionId: createNamespacedId('ipc', transport.transportId, remoteId) };
  },
  writeTerminal(runtimeSessionId, data) {
    manager.write(runtimeSessionId, Buffer.from(data, 'utf8'));
  },
};

// Own-action record (DESIGN §22.1): the append-only JSONL log of what the runtime
// itself did — injections, workspace finals, exit classifications, policy
// conflicts. One module-level recorder, default ~/.chopsticks/own-actions.jsonl.
// record() is internally serialized and error-safe; every call site fires it
// and forgets (`void`) so recording can never block or break the operation being
// recorded. A write failure surfaces on onError, never in the caller's hot path.
const recorder: ActionRecorder = createActionRecorder({
  onError: (err) => process.stderr.write(`[main] own-action record failed: ${err.message}\n`),
});
const dirtyAgentStates = new Set<string>();
let agentFlushTimer: NodeJS.Timeout | undefined;

// The workbench depends on one provider-neutral runtime. Adapter recipes,
// workspace ownership, native identities, prompt recording, and shared backend
// lifetimes all terminate inside @vibecook/chopsticks-runtime.
const agentRuntime: AgentRuntime = createBuiltinAgentRuntime({
  host,
  defaultCwd: repoRoot,
  recorder,
  onError: (err) => process.stderr.write(`[main] agent runtime: ${err.message}\n`),
});
agentRuntime.onEvent((runtimeSessionId) => {
  dirtyAgentStates.add(runtimeSessionId);
  scheduleAgentStateFlush();
});

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
  ptyHost = spawn(
    process.env.CHOPSTICKS_NODE_BIN ?? 'node',
    [resolveTsxCli(), path.join(appRoot, 'src', 'pty-host', 'main.ts')],
    {
      cwd: appRoot,
      // No stdio protocol anymore (avocado owns the socket); inherit for diagnostics.
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CHOPSTICKS_SOCKET: socket },
    },
  );
  ptyHost.on('exit', (code) => {
    process.stderr.write(`[main] pty-host exited (code ${code ?? 'null'})\n`);
  });
}

let hubDisposePromise: Promise<void> | undefined;
function disposeHub(): Promise<void> {
  if (hubDisposePromise) return hubDisposePromise;
  ptyHost?.kill('SIGTERM');
  ptyHost = undefined;
  bridge.dispose();
  manager.dispose();
  server.dispose(); // unlinks the socket file
  hubDisposePromise = agentRuntime.dispose().then((finals) => {
    for (const final of finals) pushWorkspaceFinal(final);
  });
  return hubDisposePromise;
}

/** app.exit() skips the normal quit lifecycle, so tear the hub down explicitly first. */
function exitAfterCleanup(code: number): void {
  void disposeHub().finally(() => app.exit(code));
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
  void agentRuntime
    .handleProcessExit(exit.sessionId, exit)
    .then((final) => final && pushWorkspaceFinal(final))
    .catch((err: unknown) => process.stderr.write(`[main] agent exit cleanup failed: ${String(err)}\n`));
}

function pushWorkspaceFinal(final: AgentWorkspaceFinal): void {
  mainWindow?.webContents.send('chopsticks:workspaceFinal', final);
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

// --- Agent session observation --------------------------------------------

/**
 * Flatten SessionRuntimeState for the wire: structured clone can carry a Map,
 * but the preload's typed surface models these as arrays, so collapse them to
 * arrays of values here rather than leak Map through the renderer contract.
 */
function serializeState(state: SessionRuntimeState): SerializedSessionState {
  return {
    lifecycle: state.lifecycle,
    activeTurn: state.activeTurn,
    activeReasoning: state.activeReasoning,
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

function scheduleAgentStateFlush(): void {
  if (agentFlushTimer) return;
  agentFlushTimer = setTimeout(flushAgentStateSnapshots, AGENT_FLUSH_MS);
}

/**
 * Push at most one fresh provider-neutral state/conversation snapshot per
 * session per frame. Raw adapter envelopes stop at the runtime boundary.
 */
function flushAgentStateSnapshots(): void {
  if (agentFlushTimer) {
    clearTimeout(agentFlushTimer);
    agentFlushTimer = undefined;
  }
  if (dirtyAgentStates.size === 0) return;
  const touched = [...dirtyAgentStates];
  dirtyAgentStates.clear();
  for (const runtimeSessionId of touched) pushAgentState(runtimeSessionId);
}

function pushAgentState(runtimeSessionId: string): void {
  const state = agentRuntime.sessionState(runtimeSessionId);
  const observationLevel = agentRuntime.observationLevel(runtimeSessionId);
  const conversation = agentRuntime.conversationSnapshot(runtimeSessionId);
  if (!state || !observationLevel || !conversation) return;
  mainWindow?.webContents.send('chopsticks:agentState', {
    runtimeSessionId,
    state: serializeState(state),
    observationLevel,
    conversation,
  });
}

/** Add host-only terminal metadata to the library's provider-neutral result. */
async function createAgentSessionForRenderer(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
  const result = await agentRuntime.createSession(opts);
  if ('error' in result) return result;
  const info = manager.getSessionInfo(result.runtimeSessionId);
  if (!info) throw new Error(`agent session ${result.runtimeSessionId} not registered in manager`);
  pushAgentState(result.runtimeSessionId);
  return {
    ...result,
    agent: result.agent as AgentSessionInfo['agent'],
    descriptor: infoToDescriptor(info),
  };
}

function registerIpc(): void {
  ipcMain.handle('chopsticks:createSession', (_e, opts: CreateSessionOptions) => createSession(opts));
  ipcMain.handle('chopsticks:createAgentSession', (_e, opts: CreateAgentSessionOptions) =>
    createAgentSessionForRenderer(opts),
  );
  ipcMain.handle('chopsticks:workspaceDiff', (_e, runtimeSessionId: string) =>
    agentRuntime.workspaceDiff(runtimeSessionId),
  );
  ipcMain.handle('chopsticks:submitPrompt', async (_e, opts: SubmitPromptOptions): Promise<PromptReceipt> => {
    return agentRuntime.submitPrompt(opts.runtimeSessionId, { text: opts.text });
  });
  ipcMain.handle('chopsticks:write', (_e, sessionId: string, dataBase64: string) => {
    // User priority (DESIGN §17.2): a real keystroke on an agent terminal must
    // resolve any in-flight injection as 'uncertain' BEFORE its bytes land.
    agentRuntime.notifyUserInput(sessionId);
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

  // restty copy-on-select + OSC 52 (navigator.clipboard is flaky in Electron).
  ipcMain.handle('chopsticks:clipboardWrite', (_e, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''));
    return { success: true as const };
  });
  ipcMain.handle('chopsticks:clipboardRead', () => ({
    success: true as const,
    text: clipboard.readText(),
  }));
}

// --- window ---------------------------------------------------------------

/** Keep cmd+T / cmd+W / cmd+D free for the renderer (Ghostty keybind model). */
function installMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] satisfies MenuItemConstructorOptions[]) : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  // Ghostty-parity window chrome (avocado/apps/ghostty): hiddenInset titlebar,
  // terminal-colored background, free cmd+T/W/D for the renderer surface.
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 400,
    minHeight: 300,
    title: 'chopsticks',
    backgroundColor: '#282c34',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // OS window focus → restty hollow cursor (document.hasFocus is unreliable).
  const sendWindowFocus = (focused: boolean): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('chopsticks:windowFocus', focused);
  };
  mainWindow.on('focus', () => sendWindowFocus(true));
  mainWindow.on('blur', () => sendWindowFocus(false));

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
  installMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quit is made async once so the unified runtime can dispose provider services,
// finalize workspaces, and flush its own-action records before Electron exits.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (async () => {
    try {
      await disposeHub();
    } finally {
      app.quit();
    }
  })();
});
