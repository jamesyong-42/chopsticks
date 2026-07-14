/**
 * Renderer (DESIGN §12.2, §13.3).
 *
 * One xterm.js instance per tab. Terminal input is forwarded to the backing PTY
 * as base64 (raw bytes survive intact); backend chunk events are written to the
 * matching terminal. On boot the renderer calls list() + replay() to rebuild the
 * view of already-running sessions — this is what makes Cmd-R reload recovery
 * work (acceptance criterion; the PTYs live in the pty-host, not here).
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import type {
  AgentEventMessage,
  AgentStateMessage,
  ChunkEvent,
  CreateClaudeSessionOptions,
  CreateSessionOptions,
  ExitEvent,
  SessionDescriptor,
  WorkspaceFinalEvent,
} from '../protocol.js';
import { ClaudePanel, type WorkspacePanelData } from './claude-panel.js';

const chopsticks = window.chopsticks;
const enc = new TextEncoder();

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b70',
};

class TerminalTab {
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  readonly pane: HTMLDivElement;
  readonly button: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  /** False until history has been restored, so live chunks buffer first. */
  ready = false;
  exited = false;
  /** Agent tabs (claude/codex) get the activity panel; plain terminals do not. */
  agentKind: 'claude' | 'codex' | undefined = undefined;

  constructor(
    public sessionId: string,
    private title: string,
    private readonly onInput: (sessionId: string, dataBase64: string) => void,
    private readonly onResize: (sessionId: string, cols: number, rows: number) => void,
    private readonly onSelect: (sessionId: string) => void,
    private readonly onClose: (sessionId: string) => void,
  ) {
    this.term = new Terminal({ fontFamily: 'ui-monospace, monospace', fontSize: 13, theme: THEME, scrollback: 5000 });
    this.term.loadAddon(this.fit);

    this.pane = document.createElement('div');
    this.pane.className = 'term-pane';
    this.term.open(this.pane);

    this.term.onData((data) => this.onInput(this.sessionId, bytesToB64(enc.encode(data))));
    this.term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      this.onInput(this.sessionId, bytesToB64(bytes));
    });

    this.button = document.createElement('button');
    this.button.className = 'tab';
    this.button.type = 'button';
    this.label = document.createElement('span');
    this.label.textContent = title;
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClose(this.sessionId);
    });
    this.button.append(this.label, close);
    this.button.addEventListener('click', () => this.onSelect(this.sessionId));

    new ResizeObserver(() => this.refit()).observe(this.pane);
  }

  write(bytes: Uint8Array): void {
    this.term.write(bytes);
  }

  /** Fit to the pane and push the new size to the PTY (only meaningful when visible). */
  refit(): void {
    if (this.pane.clientWidth === 0 || this.pane.clientHeight === 0) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (!this.exited) this.onResize(this.sessionId, this.term.cols, this.term.rows);
  }

  setActive(active: boolean): void {
    this.pane.classList.toggle('active', active);
    this.button.classList.toggle('active', active);
    if (active) {
      requestAnimationFrame(() => {
        this.refit();
        this.term.focus();
      });
    }
  }

  markExited(reason: string): void {
    this.exited = true;
    this.button.classList.add('exited');
    this.label.textContent = `${this.title} (${reason})`;
    this.term.write(`\r\n\x1b[2m— session ${reason} —\x1b[0m\r\n`);
  }

  dispose(): void {
    this.term.dispose();
    this.pane.remove();
    this.button.remove();
  }
}

const EVENT_TAIL_MAX = 50;

class Workbench {
  private readonly tabs = new Map<string, TerminalTab>();
  /** Chunks that arrived before their tab was registered/ready. */
  private readonly pending = new Map<string, ChunkEvent[]>();
  /** Latest serialized reducer snapshot per Claude session (runtimeSessionId). */
  private readonly claudeState = new Map<string, AgentStateMessage>();
  /** Bounded event tail per Claude session (runtimeSessionId). */
  private readonly claudeEvents = new Map<string, AgentEventEnvelope[]>();
  /** Workspace view per Claude session: initial info, live diff, final record. */
  private readonly claudeWorkspace = new Map<string, WorkspacePanelData>();
  /** The Claude `--session-id` UUID per Claude session (runtimeSessionId → sessionId), for resume. */
  private readonly claudeSessionId = new Map<string, string>();
  /** Slow-poll timers refreshing the live diff, keyed by runtimeSessionId. */
  private readonly diffPollers = new Map<string, ReturnType<typeof setInterval>>();
  private activeId: string | undefined;

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly panesEl: HTMLElement,
    private readonly panel: ClaudePanel,
  ) {
    chopsticks.onChunk((chunks) => this.onChunks(chunks));
    chopsticks.onExit((exit) => this.onExit(exit));
    chopsticks.onAgentEvents((events) => this.onAgentEvents(events));
    chopsticks.onAgentState((state) => this.onAgentState(state));
    chopsticks.onWorkspaceFinal((event) => this.onWorkspaceFinal(event));
  }

  private static readonly DIFF_POLL_MS = 10_000;

  /** Live-refresh one session's workspace diff, then repaint if it is showing. */
  private async refreshDiff(runtimeSessionId: string): Promise<void> {
    const data = this.claudeWorkspace.get(runtimeSessionId);
    // Once finalized, the workspace is gone main-side (diff → null); keep final.
    if (!data || data.final) return;
    const diff = await chopsticks.workspaceDiff(runtimeSessionId).catch(() => null);
    if (!diff) return;
    const current = this.claudeWorkspace.get(runtimeSessionId);
    if (!current || current.final) return;
    current.diff = diff;
    if (runtimeSessionId === this.activeId) this.refreshPanel();
  }

  private startDiffPoll(runtimeSessionId: string): void {
    if (this.diffPollers.has(runtimeSessionId)) return;
    const timer = setInterval(() => void this.refreshDiff(runtimeSessionId), Workbench.DIFF_POLL_MS);
    this.diffPollers.set(runtimeSessionId, timer);
  }

  private stopDiffPoll(runtimeSessionId: string): void {
    const timer = this.diffPollers.get(runtimeSessionId);
    if (timer) clearInterval(timer);
    this.diffPollers.delete(runtimeSessionId);
  }

  private onWorkspaceFinal(event: WorkspaceFinalEvent): void {
    this.stopDiffPoll(event.runtimeSessionId);
    const data = this.claudeWorkspace.get(event.runtimeSessionId);
    if (data) {
      data.final = event;
      data.diff = event.metadata.finalDiff;
    }
    if (event.runtimeSessionId === this.activeId) this.refreshPanel();
  }

  private makeTab(sessionId: string, title: string, agentKind?: 'claude' | 'codex'): TerminalTab {
    const tab = new TerminalTab(
      sessionId,
      title,
      (id, data) => void chopsticks.write(id, data),
      (id, cols, rows) => void chopsticks.resize(id, cols, rows),
      (id) => this.activate(id),
      (id) => void this.close(id),
    );
    tab.agentKind = agentKind;
    this.tabs.set(sessionId, tab);
    this.tabsEl.append(tab.button);
    this.panesEl.append(tab.pane);
    return tab;
  }

  private onAgentEvents(events: AgentEventMessage[]): void {
    let touchedActive = false;
    for (const { runtimeSessionId, envelope } of events) {
      const buf = this.claudeEvents.get(runtimeSessionId) ?? [];
      buf.push(envelope);
      if (buf.length > EVENT_TAIL_MAX) buf.splice(0, buf.length - EVENT_TAIL_MAX);
      this.claudeEvents.set(runtimeSessionId, buf);
      if (runtimeSessionId === this.activeId) touchedActive = true;
    }
    if (touchedActive) this.refreshPanel();
  }

  private onAgentState(msg: AgentStateMessage): void {
    this.claudeState.set(msg.runtimeSessionId, msg);
    // Cheap piggyback: refresh the workspace diff whenever agent state moves.
    void this.refreshDiff(msg.runtimeSessionId);
    if (msg.runtimeSessionId === this.activeId) this.refreshPanel();
  }

  /** Show the panel for the active Claude tab, or hide it for a plain terminal. */
  private refreshPanel(): void {
    const id = this.activeId;
    const tab = id ? this.tabs.get(id) : undefined;
    if (id && tab?.agentKind) {
      // Codex sessions have no workspace (Model B observes a native TUI), so pass
      // undefined — the panel then shows the agent state without a workspace section.
      const workspace = tab.agentKind === 'claude' ? this.claudeWorkspace.get(id) : undefined;
      this.panel.render(id, this.claudeState.get(id), this.claudeEvents.get(id) ?? [], workspace, tab.exited);
    } else {
      this.panel.hide();
    }
  }

  /** Mark a tab ready and drain any chunks that raced ahead of registration. */
  private flushPending(tab: TerminalTab): void {
    const queued = this.pending.get(tab.sessionId);
    this.pending.delete(tab.sessionId);
    if (queued) for (const chunk of queued) this.applyChunk(tab, chunk);
    tab.ready = true;
  }

  private applyChunk(tab: TerminalTab, chunk: ChunkEvent): void {
    tab.write(b64ToBytes(chunk.dataBase64));
  }

  private onChunks(chunks: ChunkEvent[]): void {
    for (const chunk of chunks) {
      const tab = this.tabs.get(chunk.sessionId);
      if (tab && tab.ready) {
        this.applyChunk(tab, chunk);
      } else {
        const queue = this.pending.get(chunk.sessionId) ?? [];
        queue.push(chunk);
        this.pending.set(chunk.sessionId, queue);
      }
    }
  }

  private onExit(exit: ExitEvent): void {
    this.tabs.get(exit.sessionId)?.markExited(exit.reason);
    // Stop polling now; the workspaceFinal push replaces the live diff shortly.
    this.stopDiffPoll(exit.sessionId);
    // Reflect the exit in the panel now (offer Resume) without waiting on the
    // asynchronous workspaceFinal push, which may lag or be skipped on failure.
    if (exit.sessionId === this.activeId) this.refreshPanel();
  }

  async newSession(opts: Omit<CreateSessionOptions, 'cols' | 'rows'>, title: string): Promise<void> {
    // Create + activate the tab first so the pane has real dimensions to fit.
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    const tab = this.makeTab(tempId, title);
    this.activateTab(tab);
    tab.refit();
    const descriptor = await chopsticks.createSession({
      ...opts,
      cols: tab.term.cols || 80,
      rows: tab.term.rows || 24,
    });
    this.rebind(tab, tempId, descriptor.sessionId);
    this.flushPending(tab);
  }

  /** Start a Claude session: the driver lives in main; this tab is its terminal + panel. */
  async newClaudeSession(isolation: 'shared' | 'worktree'): Promise<void> {
    await this.startClaude({ workspace: { isolation } }, isolation === 'worktree' ? 'claude ⑂' : 'claude');
  }

  /**
   * Start a Codex session (M5 C6, Model B): the tab is a native `codex --remote`
   * terminal (the user drives it); an observer in main watches the same
   * app-server and feeds this tab's activity panel. No workspace, no injection —
   * the terminal IS the input.
   */
  async newCodexSession(): Promise<void> {
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    const tab = this.makeTab(tempId, 'codex', 'codex');
    this.activateTab(tab);
    tab.refit();
    try {
      const result = await chopsticks.createCodexSession({});
      this.rebind(tab, tempId, result.runtimeSessionId);
      this.flushPending(tab);
      this.refreshPanel();
    } catch (err) {
      tab.markExited(err instanceof Error ? err.message : 'spawn failed');
    }
  }

  /**
   * Resume an EXITED Claude tab as a NEW tab that keeps the same Claude session +
   * transcript (`--resume`). Resume always reuses the original directory as a
   * SHARED workspace — main never re-materializes a worktree. For a worktree
   * session that directory survives only if it was RETAINED (dirty at finalize);
   * a destroyed worktree is gone, so we fall back to a shared repo-root session
   * (main defaults the path when omitted) and surface a note in the panel.
   */
  async resumeClaude(runtimeSessionId: string): Promise<void> {
    const sessionId = this.claudeSessionId.get(runtimeSessionId);
    const data = this.claudeWorkspace.get(runtimeSessionId);
    if (!sessionId || !data) return;
    const { info, final } = data;

    let workspace: { isolation: 'shared'; path?: string };
    let note: string | undefined;
    if (info.isolation === 'worktree') {
      if (final?.retained) {
        workspace = { isolation: 'shared', path: info.root };
      } else {
        workspace = { isolation: 'shared' }; // main defaults to the repo root
        note = 'worktree gone — resumed on repo root';
      }
    } else {
      workspace = { isolation: 'shared', path: info.root };
    }

    await this.startClaude({ resume: sessionId, workspace }, 'claude ⟲', note);
  }

  /** Shared spawn+wire path for a new or resumed Claude session. */
  private async startClaude(opts: CreateClaudeSessionOptions, title: string, note?: string): Promise<void> {
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    const tab = this.makeTab(tempId, title, 'claude');
    this.activateTab(tab);
    tab.refit();
    try {
      const result = await chopsticks.createClaudeSession(opts);
      // A workspace policy conflict / create failure comes back structured, not thrown.
      if ('error' in result) {
        tab.markExited(`${result.error.code}: ${result.error.message}`);
        return;
      }
      this.rebind(tab, tempId, result.runtimeSessionId);
      this.claudeWorkspace.set(result.runtimeSessionId, { info: result.workspace, note });
      this.claudeSessionId.set(result.runtimeSessionId, result.sessionId);
      this.startDiffPoll(result.runtimeSessionId);
      this.flushPending(tab);
      this.refreshPanel();
    } catch (err) {
      tab.markExited(err instanceof Error ? err.message : 'spawn failed');
    }
  }

  /** Attach a tab created under a temporary id to its real session id. */
  private rebind(tab: TerminalTab, tempId: string, sessionId: string): void {
    this.tabs.delete(tempId);
    tab.sessionId = sessionId;
    this.tabs.set(sessionId, tab);
    if (this.activeId === tempId) this.activeId = sessionId;
  }

  /** Rebuild tabs for sessions already running in the pty-host (reload recovery). */
  async restore(): Promise<void> {
    const sessions = await chopsticks.list();
    for (const descriptor of sessions) await this.restoreOne(descriptor);
    if (!this.activeId && sessions.length > 0) this.activate(sessions[0].sessionId);
  }

  private async restoreOne(descriptor: SessionDescriptor): Promise<void> {
    const tab = this.makeTab(descriptor.sessionId, basename(descriptor.command));
    // The hub proxy's full output buffer, written as one snapshot; live chunks
    // that raced this await are drained by flushPending right after.
    const { snapshotBase64 } = await chopsticks.replay(descriptor.sessionId);
    if (snapshotBase64) tab.write(b64ToBytes(snapshotBase64));
    this.flushPending(tab);
    if (descriptor.exited) tab.markExited('exited');
  }

  private activate(sessionId: string): void {
    const tab = this.tabs.get(sessionId);
    if (tab) this.activateTab(tab);
  }

  private activateTab(tab: TerminalTab): void {
    for (const [id, other] of this.tabs) other.setActive(id === tab.sessionId);
    tab.setActive(true);
    this.activeId = tab.sessionId;
    this.refreshPanel();
  }

  private async close(sessionId: string): Promise<void> {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;
    if (!tab.exited) await chopsticks.terminate(sessionId).catch(() => undefined);
    tab.dispose();
    this.tabs.delete(sessionId);
    this.claudeState.delete(sessionId);
    this.claudeEvents.delete(sessionId);
    this.claudeWorkspace.delete(sessionId);
    this.claudeSessionId.delete(sessionId);
    this.stopDiffPoll(sessionId);
    if (this.activeId === sessionId) {
      this.activeId = undefined;
      const next = this.tabs.keys().next();
      if (!next.done) this.activate(next.value);
      else this.refreshPanel();
    }
  }
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

const tabsEl = document.getElementById('tabs');
const panesEl = document.getElementById('terminals');
const activityEl = document.getElementById('activity');
if (!tabsEl || !panesEl || !activityEl) throw new Error('workbench DOM not found');

let workbench: Workbench;
const panel = new ClaudePanel(
  activityEl,
  (runtimeSessionId, text) => chopsticks.submitPrompt({ runtimeSessionId, text }),
  (runtimeSessionId) => void workbench.resumeClaude(runtimeSessionId),
);
workbench = new Workbench(tabsEl, panesEl, panel);
document
  .getElementById('new-shell')
  ?.addEventListener('click', () => void workbench.newSession({ kind: 'shell' }, 'shell'));
document
  .getElementById('new-fake-agent')
  ?.addEventListener('click', () => void workbench.newSession({ kind: 'fake-agent' }, 'fake agent'));
const isolationSelect = document.getElementById('claude-isolation') as HTMLSelectElement | null;
document.getElementById('new-claude')?.addEventListener('click', () => {
  const isolation = isolationSelect?.value === 'worktree' ? 'worktree' : 'shared';
  void workbench.newClaudeSession(isolation);
});
document.getElementById('new-codex')?.addEventListener('click', () => void workbench.newCodexSession());

void workbench.restore();
