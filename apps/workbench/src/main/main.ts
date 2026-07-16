import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import {
  GhostteaElectronBackend,
  type GhostteaAutomationClient,
  type GhostteaElectronBackendOptions,
  type SessionExitedEvent,
} from '@vibecook/ghosttea-electron/main';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentHost, SessionRuntimeState } from '@vibecook/chopsticks-core';
import { createActionRecorder } from '@vibecook/chopsticks-record';
import {
  buildAgentEnvironment,
  createBuiltinAgentRuntime,
  type AgentRuntime,
  type AgentWorkspaceFinal,
} from '@vibecook/chopsticks-runtime';
import type {
  AgentSessionInfo,
  AgentSessionSnapshot,
  AgentStateMessage,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PromptReceipt,
  SerializedSessionState,
  SubmitPromptOptions,
} from '../protocol.js';
import { missingManagedSessionIds } from './session-recovery.js';

declare const __dirname: string;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const AGENT_FLUSH_MS = 16;
const SMOKE = process.argv.includes('--smoke');
const appRoot = resolve(__dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const ghostteaRoot = resolve(appRoot, '../../../../electron-ghostty');

app.setName('Chopsticks');
if (process.platform === 'darwin') app.setActivationPolicy('regular');

let mainWindow: BrowserWindow | undefined;
let backend: GhostteaElectronBackend | undefined;
let quitting = false;
let quitReady = false;
let shutdownPromise: Promise<void> | undefined;
let recoveringBackend: Promise<void> | undefined;
const wiredAutomationClients = new WeakSet<GhostteaAutomationClient>();
const managedTerminalIds = new Set<string>();
const exitCleanups = new Set<Promise<unknown>>();

interface AgentRecord {
  info: AgentSessionInfo;
  session: SessionSummary;
  final?: AgentWorkspaceFinal;
}

const agentRecords = new Map<string, AgentRecord>();
const dirtyAgentStates = new Set<string>();
let agentFlushTimer: NodeJS.Timeout | undefined;

function backendOptions(): GhostteaElectronBackendOptions {
  const externalControl = process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET;
  const externalFrames = process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET;
  const externalToken = process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN;
  if (externalControl && externalFrames && externalToken) {
    return {
      mode: 'external',
      connection: { controlSocket: externalControl, frameSocket: externalFrames, authToken: externalToken },
      bridge: { entryPoint: join(__dirname, 'bridge-entry.js') },
    };
  }

  const configuredBinary =
    process.env.GHOSTTEAD_BIN ??
    (app.isPackaged
      ? join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ghosttead.exe' : 'ghosttead')
      : undefined);
  const sidecar = resolve(
    appRoot,
    '../../../truffle/packages/sidecar-slim',
    process.platform === 'win32' ? 'sidecar-slim.exe' : 'sidecar-slim',
  );
  const environment =
    !process.env.TRUFFLE_SIDECAR_PATH && existsSync(sidecar) ? { TRUFFLE_SIDECAR_PATH: sidecar } : undefined;
  return {
    mode: 'managed',
    daemon: {
      binary: configuredBinary
        ? { kind: 'executable', path: configuredBinary }
        : {
            kind: 'cargo',
            manifestPath: join(ghostteaRoot, 'native/ghosttead/Cargo.toml'),
            release: process.env.GHOSTTEA_DEV_PROFILE !== 'debug',
          },
      ...(environment ? { environment } : {}),
    },
    bridge: { entryPoint: join(__dirname, 'bridge-entry.js') },
    automation: { clientBuild: 'chopsticks-workbench' },
  };
}

const host: AgentHost = {
  async spawnTerminal(spec) {
    await ensureBackend();
    const session = await backend!.automation.createSession({
      executable: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      environment: { mode: 'clean', variables: buildAgentEnvironment({ allowed: spec.env }) },
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
      persistence: 'terminate-with-app',
    });
    managedTerminalIds.add(session.id);
    return { runtimeSessionId: session.id };
  },
  async automateTerminal(runtimeSessionId, operation) {
    await ensureBackend();
    const client = backend!.automation;
    const result =
      operation.kind === 'paste'
        ? operation.submit
          ? await client.pasteAndSubmit(runtimeSessionId, operation.text)
          : await client.paste(runtimeSessionId, operation.text)
        : operation.kind === 'text'
          ? await client.sendText(runtimeSessionId, operation.text)
          : await client.interrupt(runtimeSessionId);
    return result.accepted ? { accepted: true } : { accepted: false, reason: result.reason ?? 'human-input-conflict' };
  },
};

const recorder = createActionRecorder({
  onError: (error) => process.stderr.write(`[main] own-action record failed: ${error.message}\n`),
});
const agentRuntime: AgentRuntime = createBuiltinAgentRuntime({
  host,
  defaultCwd: repoRoot,
  recorder,
  onError: (error) => process.stderr.write(`[main] agent runtime: ${error.message}\n`),
});
agentRuntime.onEvent((runtimeSessionId) => {
  dirtyAgentStates.add(runtimeSessionId);
  scheduleAgentStateFlush();
});

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

function stateSnapshot(runtimeSessionId: string): AgentStateMessage | undefined {
  const state = agentRuntime.sessionState(runtimeSessionId);
  const observationLevel = agentRuntime.observationLevel(runtimeSessionId);
  const conversation = agentRuntime.conversationSnapshot(runtimeSessionId);
  if (!state || !observationLevel || !conversation) return undefined;
  return { runtimeSessionId, state: serializeState(state), observationLevel, conversation };
}

function scheduleAgentStateFlush(): void {
  if (agentFlushTimer) return;
  agentFlushTimer = setTimeout(() => {
    agentFlushTimer = undefined;
    const sessionIds = [...dirtyAgentStates];
    dirtyAgentStates.clear();
    for (const sessionId of sessionIds) {
      const snapshot = stateSnapshot(sessionId);
      if (snapshot) mainWindow?.webContents.send('chopsticks:agent-state', snapshot);
    }
  }, AGENT_FLUSH_MS);
}

function pushWorkspaceFinal(final: AgentWorkspaceFinal): void {
  const record = agentRecords.get(final.runtimeSessionId);
  if (record) record.final = final;
  mainWindow?.webContents.send('chopsticks:workspace-final', final);
}

function onSessionExited(event: SessionExitedEvent): void {
  if (!managedTerminalIds.delete(event.sessionId)) return;
  const record = agentRecords.get(event.sessionId);
  if (record) {
    record.session = {
      ...record.session,
      exited: true,
      exitCode: event.exitCode,
      exitSignal: event.exitSignal,
      requestedTermination: event.requestedTermination,
      exitOutcome: event.exitOutcome,
    };
  }
  const cleanup = agentRuntime
    .handleProcessExit(event.sessionId, {
      exitCode: event.exitCode,
      signal: event.exitSignal,
      reason: event.exitOutcome,
    })
    .then((final) => {
      if (final) pushWorkspaceFinal(final);
    })
    .catch((error: unknown) => process.stderr.write(`[main] agent exit cleanup failed: ${String(error)}\n`))
    .finally(() => exitCleanups.delete(cleanup));
  exitCleanups.add(cleanup);
}

function wireAutomation(client: GhostteaAutomationClient): void {
  if (wiredAutomationClients.has(client)) return;
  wiredAutomationClients.add(client);
  client.on('session-exited', onSessionExited);
}

async function ensureBackend(): Promise<void> {
  if (!backend) {
    backend = new GhostteaElectronBackend(backendOptions());
    backend.on('unexpected-exit', ({ source, code, signal }) => {
      if (quitting) return;
      console.error(`${source} exited unexpectedly (${code ?? signal ?? 'unknown'}); restarting`);
      void recoverBackend();
    });
  }
  if (!backend.running) await backend.start();
  const automation = backend.automation;
  wireAutomation(automation);
}

async function reconcileManagedSessions(): Promise<void> {
  if (!backend) return;
  const liveSessionIds = (await backend.automation.listSessions()).map((session) => session.id);
  for (const sessionId of missingManagedSessionIds(managedTerminalIds, liveSessionIds)) {
    onSessionExited({
      requestId: 0,
      type: 'session-exited',
      sessionId,
      exitCode: null,
      exitSignal: null,
      requestedTermination: null,
      exitOutcome: 'unknown',
    });
  }
}

function recoverBackend(): Promise<void> {
  recoveringBackend ??= (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5 && !quitting; attempt += 1) {
      try {
        await ensureBackend();
        await reconcileManagedSessions();
        mainWindow?.webContents.reload();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(5_000, 250 * 2 ** attempt)));
      }
    }
    if (lastError) console.error('terminal backend recovery failed', lastError);
  })().finally(() => {
    recoveringBackend = undefined;
  });
  return recoveringBackend;
}

async function createAgentSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
  const result = await agentRuntime.createSession(options);
  if ('error' in result) return result;
  const session = await backend!.automation.getSession(result.runtimeSessionId);
  const info: AgentSessionInfo = { ...result, agent: result.agent as AgentSessionInfo['agent'], session };
  agentRecords.set(result.runtimeSessionId, { info, session });
  const snapshot = stateSnapshot(result.runtimeSessionId);
  if (snapshot) mainWindow?.webContents.send('chopsticks:agent-state', snapshot);
  return info;
}

function registerIpc(): void {
  ipcMain.handle('chopsticks:create-agent-session', (_event, options: CreateAgentSessionOptions) =>
    createAgentSession(options),
  );
  ipcMain.handle('chopsticks:list-agent-sessions', (): AgentSessionSnapshot[] =>
    [...agentRecords.values()].map((record) => ({
      info: { ...record.info, session: record.session },
      state: stateSnapshot(record.info.runtimeSessionId),
      final: record.final,
    })),
  );
  ipcMain.handle('chopsticks:submit-prompt', (_event, options: SubmitPromptOptions): Promise<PromptReceipt> =>
    agentRuntime.submitPrompt(options.runtimeSessionId, { text: options.text }),
  );
  ipcMain.handle('chopsticks:workspace-diff', (_event, runtimeSessionId: string) =>
    agentRuntime.workspaceDiff(runtimeSessionId),
  );
}

ipcMain.on('terminal-context-menu', (event, canCopy: boolean) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const send = (action: string): void => mainWindow?.webContents.send('terminal-menu-action', action);
  Menu.buildFromTemplate([
    { label: 'Copy', enabled: Boolean(canCopy), click: () => send('copy') },
    { label: 'Paste', click: () => send('paste') },
    { type: 'separator' },
    { label: 'Select All', click: () => send('select-all') },
    { label: 'Clear Screen', click: () => send('clear-screen') },
  ]).popup({ window: mainWindow });
});

ipcMain.on('terminal-toggle-fullscreen', (event) => {
  if (mainWindow && event.sender === mainWindow.webContents) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.on('terminal-close-window', (event) => {
  if (mainWindow && event.sender === mainWindow.webContents) mainWindow.close();
});

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }
  await ensureBackend();
  const window = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 680,
    minHeight: 360,
    show: false,
    title: 'Chopsticks',
    backgroundColor: '#282c34',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 8 } } : {}),
    acceptFirstMouse: true,
    fullscreenable: true,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  const reveal = (): void => {
    if (window.isDestroyed()) return;
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.show();
    window.focus();
  };
  window.once('ready-to-show', reveal);
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed() && backend?.running) backend.attachRenderer(window.webContents);
  });
  await window.loadFile(join(__dirname, 'index.html'));
  reveal();
}

async function runSmoke(): Promise<void> {
  await ensureBackend();
  const session = await backend!.automation.createSession({
    executable: '/bin/echo',
    args: ['SMOKE OK'],
    environment: { mode: 'inherit' },
    cols: 80,
    rows: 24,
    persistence: 'terminate-with-app',
  });
  const exited = await backend!.automation.waitForExit(session.id, 20_000);
  if (exited.exitCode !== 0) throw new Error(`smoke session exited ${exited.exitCode ?? exited.exitSignal}`);
  console.log('SMOKE OK');
}

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    quitting = true;
    if (agentFlushTimer) clearTimeout(agentFlushTimer);
    const client = backend?.automation;
    if (client) {
      await Promise.allSettled([...managedTerminalIds].map((id) => client.terminateAndWait(id, 'application', 5_000)));
    }
    await Promise.allSettled([...exitCleanups]);
    const finals = await agentRuntime.dispose();
    for (const final of finals) pushWorkspaceFinal(final);
    backend?.stop();
    backend = undefined;
  })();
  return shutdownPromise;
}

registerIpc();
app
  .whenReady()
  .then(async () => {
    if (SMOKE) {
      await runSmoke();
      await shutdown();
      app.exit(0);
      return;
    }
    await createWindow();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on('activate', () => {
  if (!mainWindow) void createWindow().catch((error) => console.error('failed to recreate window', error));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  void shutdown().finally(() => {
    quitReady = true;
    app.quit();
  });
});
