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
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
} from 'electron';
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
import { createClaudeSession } from '@vibecook/chopsticks-adapter-claude';
import { createCodexTuiSession } from '@vibecook/chopsticks-adapter-codex';
import { createGrokBackend, type GrokBackend } from '@vibecook/chopsticks-adapter-acp';
import { createActionRecorder, type ActionRecorder } from '@vibecook/chopsticks-record';
import type { AgentEventEnvelope, AgentHost, AgentSession, SessionRuntimeState } from '@vibecook/chopsticks-core';
import {
  assertWorkspacePolicy,
  createWorkspace,
  WorkspaceError,
  type Workspace,
  type WorkspaceRequest,
} from '@vibecook/chopsticks-workspaces';
import type {
  AgentEventMessage,
  ChunkEvent,
  CodexSessionInfo,
  CreateClaudeSessionOptions,
  CreateClaudeSessionResult,
  CreateCodexSessionOptions,
  CreateGrokSessionOptions,
  CreateSessionOptions,
  ExitEvent,
  GrokSessionInfo,
  PromptReceipt,
  SerializedSessionState,
  SessionDescriptor,
  SubmitPromptOptions,
  WorkspaceInfo,
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
// Every agent (Claude / Codex / Grok) is one core `AgentSession` (DESIGN §9):
// the adapter owns its spawn recipe (hooks+PTY for Claude, app-server+`codex
// --remote` for Codex, leader+`grok --leader` for Grok) and the workbench just
// provides an `AgentHost` and observes/controls the returned handle. Keyed by
// runtimeSessionId — the same namespaced manager id the terminal surface uses.
const agentSessions = new Map<string, AgentSession>();
// The Claude `--session-id` UUID (the own-action record's join key) keyed by
// runtimeSessionId. OUTLIVES the AgentSession: both the exit
// path (forwardExit) and the quit path (disposeHub → finalizeAllWorkspaces)
// dispose/clear the ClaudeSession before finalizeWorkspace records the
// workspace-final, so the join key is preserved here to stamp that record. An
// entry is removed once its workspace-final is written (or process exit).
const claudeSessionIds = new Map<string, string>();
// The workspace each Claude session runs in, keyed by the SAME runtimeSessionId.
// A shared workspace's destroy() is a no-op by contract; only worktrees are torn
// down on exit, and never forcibly when dirty (uncommitted work is kept).
const activeWorkspaces = new Map<string, Workspace>();

// Agent executables resolve via the pty-host's inherited PATH (fine when the
// workbench is launched from a shell); override with an absolute path for a
// bundled .app.
const CODEX_BIN = process.env.CHOPSTICKS_CODEX_BIN ?? 'codex';
const GROK_BIN = process.env.CHOPSTICKS_GROK_BIN ?? 'grok';

// The terminal capability the adapters spawn/write their native TUIs through
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

// Grok's shared `grok agent leader` lives inside its backend — created lazily on
// the first Grok tab, torn down at hub dispose.
let grokBackend: GrokBackend | undefined;
function getGrokBackend(): GrokBackend {
  return (grokBackend ??= createGrokBackend({ executable: GROK_BIN, host }));
}

/** Wire a new agent session into the event fan-out + the unified registry. */
function registerAgentSession(session: AgentSession): void {
  agentSessions.set(session.runtimeSessionId, session);
  session.onEvent((envelope: AgentEventEnvelope) => {
    agentEventBatch.push({ runtimeSessionId: session.runtimeSessionId, envelope });
    scheduleAgentFlush();
  });
}

// Own-action record (DESIGN §22.1): the append-only JSONL log of what the runtime
// itself did — injections, workspace finals, exit classifications, policy
// conflicts. One module-level recorder, default ~/.chopsticks/own-actions.jsonl.
// record() is internally serialized and error-safe; every call site fires it
// and forgets (`void`) so recording can never block or break the operation being
// recorded. A write failure surfaces on onError, never in the caller's hot path.
const recorder: ActionRecorder = createActionRecorder({
  onError: (err) => process.stderr.write(`[main] own-action record failed: ${err.message}\n`),
});
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

let hubDisposed = false;
function disposeHub(): void {
  if (hubDisposed) return;
  hubDisposed = true;
  // Tear down agent observation before the transport goes: each session's
  // dispose() stops its own backing services (hook bridge + transcript observer
  // for Claude, observer + app-server for Codex, ACP control client for Grok).
  for (const session of agentSessions.values()) void session.dispose().catch(() => undefined);
  agentSessions.clear();
  // Then the Grok backend's shared `grok agent leader`.
  grokBackend?.dispose();
  grokBackend = undefined;
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
  // An agent session's PTY just ended: tear down its observation (each session's
  // dispose() knows its own backing services). The process is already gone.
  // Claude sessions carry an own-action join key (which OUTLIVES the session, for
  // the workspace-final record); record the exit classification BEFORE disposing.
  // Codex/Grok have no join key here, so this fires only for Claude.
  const claudeJoinId = claudeSessionIds.get(exit.sessionId);
  if (claudeJoinId) {
    void recorder.record({
      type: 'session-exit',
      sessionId: claudeJoinId,
      runtimeSessionId: exit.sessionId,
      exitCode: exit.exitCode,
      signal: exit.signal,
      reason: exit.reason,
    });
  }
  const session = agentSessions.get(exit.sessionId);
  if (session) {
    agentSessions.delete(exit.sessionId);
    void session.dispose().catch(() => undefined);
  }
  // Finalize the session's workspace: record its final diff, push the metadata,
  // and (worktree only) remove the worktree — retaining it if it is dirty.
  const workspace = activeWorkspaces.get(exit.sessionId);
  if (workspace) {
    activeWorkspaces.delete(exit.sessionId);
    void finalizeWorkspace(exit.sessionId, workspace);
  }
}

/**
 * Finalize one workspace and inform the renderer. finalize() snapshots the final
 * diff/commit; the metadata is already plain JSON, so it rides structured clone
 * as-is. Worktrees are then destroyed WITHOUT force: a dirty worktree throws
 * WORKSPACE_DIRTY and is kept (branch + worktree intact), surfaced as
 * `retained` so the user can recover the uncommitted work. Best-effort: a
 * finalize failure is logged and the event is skipped rather than thrown.
 */
async function finalizeWorkspace(runtimeSessionId: string, workspace: Workspace): Promise<void> {
  let metadata;
  try {
    metadata = await workspace.finalize();
  } catch (err) {
    process.stderr.write(`[main] workspace finalize failed (${runtimeSessionId}): ${(err as Error).message}\n`);
    return;
  }

  let retained = false;
  let reason: string | undefined;
  if (workspace.isolation === 'worktree') {
    try {
      await workspace.destroy();
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === 'WORKSPACE_DIRTY') {
        // Never force: keep the worktree and branch so the work isn't lost.
        retained = true;
        reason = err.message;
      } else {
        process.stderr.write(`[main] workspace destroy failed (${runtimeSessionId}): ${(err as Error).message}\n`);
      }
    }
  }

  // Record the workspace-final own-action. sessionId is REQUIRED in OwnActionBase
  // and only a Claude session has one, so we stamp the record with the preserved
  // Claude sessionId for this runtimeSessionId. In this workbench every workspace
  // is a Claude session's workspace, but should a non-Claude/workspace-only session
  // ever reach here it has no sessionId to join on — we skip its record rather than
  // fabricate a runtime id in the join field. The map entry is consumed here.
  const sessionId = claudeSessionIds.get(runtimeSessionId);
  claudeSessionIds.delete(runtimeSessionId);
  if (sessionId) {
    void recorder.record({
      type: 'workspace-final',
      sessionId,
      runtimeSessionId,
      isolation: workspace.isolation,
      branch: workspace.branch,
      initialCommit: workspace.initialCommit,
      finalCommit: metadata.finalCommit,
      filesTouched: metadata.filesTouched,
      retained,
    });
  }

  mainWindow?.webContents.send('chopsticks:workspaceFinal', { runtimeSessionId, metadata, retained, reason });
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
    // Every agent session exposes state()/observationLevel() (core AgentSession).
    const source = agentSessions.get(runtimeSessionId);
    if (!source) continue;
    mainWindow?.webContents.send('chopsticks:agentState', {
      runtimeSessionId,
      state: serializeState(source.state()),
      observationLevel: source.observationLevel(),
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
async function createClaudeSessionForRenderer(opts: CreateClaudeSessionOptions): Promise<CreateClaudeSessionResult> {
  // Default (omitted) is the current behavior: a shared workspace on the repo
  // root (honoring a legacy `cwd` override as the shared path).
  const request: WorkspaceRequest = {
    isolation: opts.workspace?.isolation ?? 'shared',
    path: opts.workspace?.path ?? opts.cwd ?? repoRoot,
  };

  // §20.3 — one writer per shared root. A conflict (or a create failure) comes
  // back to the renderer as a structured error rather than an opaque throw.
  try {
    assertWorkspacePolicy([...activeWorkspaces.values()], request);
  } catch (err) {
    if (err instanceof WorkspaceError) {
      // A policy refusal: the session never started, so there is no Claude
      // sessionId yet. OwnActionBase requires a join key, so we stamp a synthetic
      // `pending:<requested cwd>` marker — the refusal is about that root, and it
      // is trivially distinguished from a real UUID by the prefix.
      void recorder.record({
        type: 'policy-conflict',
        sessionId: `pending:${request.path}`,
        code: err.code,
        message: err.message,
      });
      return { error: { code: err.code, message: err.message } };
    }
    throw err;
  }

  let workspace: Workspace;
  try {
    workspace = await createWorkspace(request);
  } catch (err) {
    if (err instanceof WorkspaceError) return { error: { code: err.code, message: err.message } };
    throw err;
  }

  const session = await createClaudeSession({
    cwd: workspace.root,
    title: opts.title,
    // Native resume: the driver keeps the session's id + transcript when this is
    // set. cwd is the reconstructed workspace root (a SHARED workspace over the
    // original directory — the renderer never asks main to re-materialize a
    // worktree on resume), so a resumed session reuses the existing directory.
    resume: opts.resume,
    // Bridge Claude's richer `ports` onto the shared host: its spawn callback
    // receives the FULL prepared session (settingsPath + CHOPSTICKS_HOOK_TOKEN
    // env), which rides host.spawnTerminal's env grants → pty-host allowlist →
    // Claude's hooks. `write` is the same direct-manager path every agent uses.
    ports: {
      spawn: (prepared) => host.spawnTerminal(prepared),
      write: host.writeTerminal,
    },
  }).catch(async (err: unknown) => {
    // The workspace exists but the session never started: don't leak a worktree.
    // Nothing ran in it, so it is clean and a non-force destroy succeeds.
    await workspace.destroy().catch(() => undefined);
    throw err;
  });

  activeWorkspaces.set(session.runtimeSessionId, workspace);
  registerAgentSession(session);
  // Preserve the join key so the exit/quit paths can stamp the workspace-final
  // record after the ClaudeSession itself is disposed.
  claudeSessionIds.set(session.runtimeSessionId, session.sessionId);

  const info = manager.getSessionInfo(session.runtimeSessionId);
  if (!info) throw new Error(`claude session ${session.runtimeSessionId} not registered in manager`);
  const workspaceInfo: WorkspaceInfo = {
    isolation: workspace.isolation,
    root: workspace.root,
    branch: workspace.branch,
    initialCommit: workspace.initialCommit,
  };
  return {
    sessionId: session.sessionId,
    runtimeSessionId: session.runtimeSessionId,
    descriptor: infoToDescriptor(info),
    workspace: workspaceInfo,
  };
}

/**
 * Start a Codex session. Unlike Claude (one PTY observed via hooks), a Codex
 * session is: (1) a private `codex app-server` on a unix socket, (2) a
 * controller-owned thread (`thread/start` + empty inject so the panel is ready
 * before any keystroke), (3) a native `codex resume <id> --remote` TUI in a PTY
 * — the terminal tab, spawned through the SAME avocado transport as every other
 * session. The user drives the terminal; chopsticks already owns/observes the
 * thread, so lifecycle leaves `preparing` immediately (Grok/Claude parity).
 */
async function createCodexSessionForRenderer(opts: CreateCodexSessionOptions): Promise<CodexSessionInfo> {
  const session = await createCodexTuiSession({
    cwd: opts.cwd ?? repoRoot,
    resume: opts.resume,
    executable: CODEX_BIN,
    host,
  });
  registerAgentSession(session);
  const info = manager.getSessionInfo(session.runtimeSessionId);
  if (!info) throw new Error(`codex session ${session.runtimeSessionId} not registered in manager`);
  // Thread id is known at create time (controller-owned start, or resume id).
  return {
    runtimeSessionId: session.runtimeSessionId,
    descriptor: infoToDescriptor(info),
    threadId: session.sessionId || undefined,
  };
}

/**
 * Start a Grok session (M6 A6c): the tab is a native `grok --leader` TUI on the
 * backend's shared leader; an ACP control client attaches to the SAME session to
 * observe + inject. The adapter's backend owns the whole recipe (leader, TUI
 * spawn via the host, welcome-preserving `--session-id`/`--resume`, and the
 * async control attach) — see `createGrokBackend`. This returns as soon as the
 * terminal is up; control comes online in the background.
 */
async function createGrokSessionForRenderer(opts: CreateGrokSessionOptions): Promise<GrokSessionInfo> {
  const session = await getGrokBackend().createSession({ cwd: opts.cwd ?? repoRoot, resume: opts.resume });
  registerAgentSession(session);
  const info = manager.getSessionInfo(session.runtimeSessionId);
  if (!info) throw new Error(`grok session ${session.runtimeSessionId} not registered in manager`);
  return {
    runtimeSessionId: session.runtimeSessionId,
    descriptor: infoToDescriptor(info),
    sessionId: session.sessionId,
  };
}

function registerIpc(): void {
  ipcMain.handle('chopsticks:createSession', (_e, opts: CreateSessionOptions) => createSession(opts));
  ipcMain.handle('chopsticks:createClaudeSession', (_e, opts: CreateClaudeSessionOptions) =>
    createClaudeSessionForRenderer(opts ?? {}),
  );
  ipcMain.handle('chopsticks:createCodexSession', (_e, opts: CreateCodexSessionOptions) =>
    createCodexSessionForRenderer(opts ?? {}),
  );
  ipcMain.handle('chopsticks:createGrokSession', (_e, opts: CreateGrokSessionOptions) =>
    createGrokSessionForRenderer(opts ?? {}),
  );
  ipcMain.handle('chopsticks:workspaceDiff', (_e, runtimeSessionId: string) => {
    const workspace = activeWorkspaces.get(runtimeSessionId);
    return workspace ? workspace.diff() : null;
  });
  ipcMain.handle('chopsticks:submitPrompt', async (_e, opts: SubmitPromptOptions): Promise<PromptReceipt> => {
    const session = agentSessions.get(opts.runtimeSessionId);
    // No session → nothing was injected and no id to join on; inform the UI.
    if (!session) return { status: 'rejected', reason: 'no such session' };
    // Every agent injects through its OWN submitPrompt (guarded paste for Claude,
    // bracketed paste into the native TUI for Codex, deterministic session/prompt
    // for Grok) — the adapter owns the mechanism. Record the honest receipt
    // (DESIGN §17): `uncertain` rides through as itself, never collapsed.
    const receipt = await session.submitPrompt({ text: opts.text });
    void recorder.record({
      type: 'injection',
      // The join key is the agent's native id; '' until a Codex thread
      // materializes, so fall back to a pending marker.
      sessionId: session.sessionId || `pending:${opts.runtimeSessionId}`,
      runtimeSessionId: opts.runtimeSessionId,
      text: opts.text,
      outcome: receipt.status,
      reason: 'reason' in receipt ? receipt.reason : undefined,
      turnId: 'turnId' in receipt ? receipt.turnId : undefined,
    });
    return receipt;
  });
  ipcMain.handle('chopsticks:write', (_e, sessionId: string, dataBase64: string) => {
    // User priority (DESIGN §17.2): a real keystroke on an agent terminal must
    // resolve any in-flight injection as 'uncertain' BEFORE its bytes land.
    // notifyUserInput is a no-op for native-TUI drivers (Codex/Grok), so this is
    // safe for every agent kind.
    agentSessions.get(sessionId)?.notifyUserInput();
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

/**
 * Finalize every remaining workspace, best-effort. Same retained-on-dirty rule
 * as the per-session exit path (worktrees are never force-destroyed), so a quit
 * mid-work keeps the branch + worktree. allSettled so one failure never blocks
 * the quit.
 */
async function finalizeAllWorkspaces(): Promise<void> {
  const entries = [...activeWorkspaces.entries()];
  activeWorkspaces.clear();
  await Promise.allSettled(entries.map(([id, ws]) => finalizeWorkspace(id, ws)));
}

// Quit is made async once: tear down Claude sessions + the hub, THEN finalize the
// workspaces (order matters — observation is gone before we snapshot the diff),
// then re-enter quit, which the `quitting` guard lets through.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (async () => {
    try {
      disposeHub();
      await finalizeAllWorkspaces();
    } finally {
      app.quit();
    }
  })();
});
