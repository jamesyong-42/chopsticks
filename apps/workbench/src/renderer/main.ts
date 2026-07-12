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
import type { ChunkEvent, CreateSessionOptions, ExitEvent, SessionDescriptor } from '../protocol.js';

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
  /** Highest sequence written; guards against replay/live overlap on reload. */
  lastSequence = 0;
  /** False until history has been restored, so live chunks buffer first. */
  ready = false;
  exited = false;

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

class Workbench {
  private readonly tabs = new Map<string, TerminalTab>();
  /** Chunks that arrived before their tab was registered/ready. */
  private readonly pending = new Map<string, ChunkEvent[]>();
  private activeId: string | undefined;

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly panesEl: HTMLElement,
  ) {
    chopsticks.onChunk((chunks) => this.onChunks(chunks));
    chopsticks.onExit((exit) => this.onExit(exit));
  }

  private makeTab(sessionId: string, title: string): TerminalTab {
    const tab = new TerminalTab(
      sessionId,
      title,
      (id, data) => void chopsticks.write(id, data),
      (id, cols, rows) => void chopsticks.resize(id, cols, rows),
      (id) => this.activate(id),
      (id) => void this.close(id),
    );
    this.tabs.set(sessionId, tab);
    this.tabsEl.append(tab.button);
    this.panesEl.append(tab.pane);
    return tab;
  }

  /** Mark a tab ready and drain any chunks that raced ahead of registration. */
  private flushPending(tab: TerminalTab): void {
    const queued = this.pending.get(tab.sessionId);
    this.pending.delete(tab.sessionId);
    if (queued) for (const chunk of queued) this.applyChunk(tab, chunk);
    tab.ready = true;
  }

  private applyChunk(tab: TerminalTab, chunk: ChunkEvent): void {
    if (chunk.sequence <= tab.lastSequence) return;
    tab.write(b64ToBytes(chunk.dataBase64));
    tab.lastSequence = chunk.sequence;
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
    const replay = await chopsticks.replay(descriptor.sessionId, 0);
    for (const chunk of replay.chunks)
      this.applyChunk(tab, { event: 'chunk', sessionId: descriptor.sessionId, ...chunk });
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
  }

  private async close(sessionId: string): Promise<void> {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;
    if (!tab.exited) await chopsticks.terminate(sessionId).catch(() => undefined);
    tab.dispose();
    this.tabs.delete(sessionId);
    if (this.activeId === sessionId) {
      this.activeId = undefined;
      const next = this.tabs.keys().next();
      if (!next.done) this.activate(next.value);
    }
  }
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

const tabsEl = document.getElementById('tabs');
const panesEl = document.getElementById('terminals');
if (!tabsEl || !panesEl) throw new Error('workbench DOM not found');

const workbench = new Workbench(tabsEl, panesEl);
document
  .getElementById('new-shell')
  ?.addEventListener('click', () => void workbench.newSession({ kind: 'shell' }, 'shell'));
document
  .getElementById('new-fake-agent')
  ?.addEventListener('click', () => void workbench.newSession({ kind: 'fake-agent' }, 'fake agent'));

void workbench.restore();
