/**
 * Agent chat panel (DESIGN §12.2 renderer, §19 observation surface).
 *
 * A conversation view over the ACTIVE agent tab — Claude, Codex, or Grok,
 * uniformly. The renderer never holds a live `AgentSession`; it gets a serialized
 * reducer snapshot + a bounded event tail from main and RECONSTRUCTS a chat
 * thread from them (turn.started → a user message, assistant.message → the
 * assistant reply accumulating in place, tool.* → inline tool chips). On top of
 * that pure presentation sits the ONE control affordance: the composer, whose
 * Send routes back through `submitPrompt`.
 *
 * The thread rebuilds on every state/event push (cheap — the tail is bounded);
 * the composer is a separate element that is never rebuilt, so a push never wipes
 * what the user is typing. The status pill's elapsed timer updates on its own
 * without touching the thread.
 *
 * The one agent-specific extra — a git workspace (Claude today) — is a
 * collapsible disclosure that hides itself when there is no workspace data.
 */

import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import type {
  AgentStateMessage,
  PromptReceipt,
  WorkspaceDiff,
  WorkspaceFinalEvent,
  WorkspaceInfo,
} from '../protocol.js';

const WS_FILES_MAX = 12;

type SubmitFn = (runtimeSessionId: string, text: string) => Promise<PromptReceipt>;
type ResumeFn = (runtimeSessionId: string) => void;

/**
 * The renderer's view of one session's workspace: the info known at creation, the
 * latest live diff, and the final record once the session exits.
 */
export interface WorkspacePanelData {
  info: WorkspaceInfo;
  diff?: WorkspaceDiff;
  final?: WorkspaceFinalEvent;
  /** Set on a resumed session that had to fall back (e.g. its worktree was gone). */
  note?: string;
}

// ── Thread reconstruction ───────────────────────────────────────────────────

interface ToolChip {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
}
interface ThreadItem {
  kind: 'user' | 'assistant' | 'note';
  turnId?: string;
  text: string;
  tools: ToolChip[];
  streaming: boolean;
  error?: boolean;
}

/** Rebuild an ordered chat thread from the bounded event tail. */
function buildThread(events: AgentEventEnvelope[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  const asstByTurn = new Map<string, ThreadItem>();

  const ensureAssistant = (turnId: string | undefined): ThreadItem => {
    const key = turnId ?? '∅';
    let a = asstByTurn.get(key);
    if (!a) {
      a = { kind: 'assistant', turnId, text: '', tools: [], streaming: true };
      asstByTurn.set(key, a);
      items.push(a);
    }
    return a;
  };

  for (const env of events) {
    const e = env.event as Record<string, unknown> & { type: string };
    const turnId = (env.turnId ?? (e.turnId as string | undefined)) as string | undefined;
    switch (e.type) {
      case 'turn.started':
        if (typeof e.prompt === 'string' && e.prompt.trim()) {
          items.push({ kind: 'user', turnId, text: e.prompt, tools: [], streaming: false });
        }
        break;
      case 'assistant.message': {
        const a = ensureAssistant(turnId);
        if (typeof e.text === 'string') a.text = e.text;
        a.streaming = e.final === false;
        break;
      }
      case 'tool.requested':
      case 'tool.started': {
        const a = ensureAssistant(turnId);
        const id = String(e.toolCallId ?? '');
        if (!a.tools.some((t) => t.id === id)) {
          a.tools.push({ id, name: String(e.tool || id || 'tool'), status: 'running' });
        }
        break;
      }
      case 'tool.completed':
      case 'tool.failed': {
        const a = ensureAssistant(turnId);
        const id = String(e.toolCallId ?? '');
        const status = e.type === 'tool.failed' ? 'failed' : 'done';
        const chip = a.tools.find((t) => t.id === id);
        if (chip) chip.status = status;
        else a.tools.push({ id, name: String(e.tool || id || 'tool'), status });
        break;
      }
      case 'turn.completed': {
        const a = asstByTurn.get(turnId ?? '∅');
        if (a) {
          a.streaming = false;
          if (!a.text && typeof e.lastAssistantMessage === 'string') a.text = e.lastAssistantMessage;
        } else if (typeof e.lastAssistantMessage === 'string' && e.lastAssistantMessage) {
          items.push({ kind: 'assistant', turnId, text: e.lastAssistantMessage, tools: [], streaming: false });
        }
        break;
      }
      case 'turn.failed': {
        const a = asstByTurn.get(turnId ?? '∅');
        if (a) a.streaming = false;
        items.push({
          kind: 'note',
          text: `turn failed${e.error ? `: ${e.error}` : ''}`,
          tools: [],
          streaming: false,
          error: true,
        });
        break;
      }
      case 'notification':
        if (typeof e.message === 'string' && e.message) {
          items.push({
            kind: 'note',
            text: e.message,
            tools: [],
            streaming: false,
            error: e.notificationType === 'error',
          });
        }
        break;
      default:
        break;
    }
  }
  return items;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function truncatePath(p: string, max = 42): string {
  return p.length <= max ? p : '…' + p.slice(p.length - (max - 1));
}

const TOOL_ICON: Record<ToolChip['status'], string> = { running: '◍', done: '✓', failed: '✗' };

export class AgentPanel {
  private shownSessionId: string | undefined;
  private agentKind = 'agent';

  // Header
  private readonly kindBadge: HTMLSpanElement;
  private readonly statusDot: HTMLSpanElement;
  private readonly statusText: HTMLSpanElement;
  private readonly resumeBtn: HTMLButtonElement;
  // Attention + context
  private readonly permsBanner: HTMLDivElement;
  private readonly wsDisclosure: HTMLDetailsElement;
  private readonly wsSummary: HTMLElement;
  private readonly wsBody: HTMLDivElement;
  // Conversation
  private readonly thread: HTMLDivElement;
  // Composer
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly receiptBox: HTMLDivElement;

  // Live turn ticker: only the status pill updates on tick, never the thread.
  private activeTurnStartedAt: number | undefined;
  private turnLabel = '';
  private readonly elapsedTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly root: HTMLElement,
    private readonly onSubmit: SubmitFn,
    private readonly onResume: ResumeFn,
  ) {
    root.classList.add('activity', 'chat');

    // Header: agent identity · live status · resume.
    const header = el('div', 'chat-header');
    this.kindBadge = el('span', 'kind-badge');
    const status = el('span', 'status-pill');
    this.statusDot = el('span', 'status-dot');
    this.statusText = el('span', 'status-text', 'idle');
    status.append(this.statusDot, this.statusText);
    this.resumeBtn = el('button', 'resume-btn', '⟲ Resume');
    this.resumeBtn.type = 'button';
    this.resumeBtn.classList.add('hidden');
    this.resumeBtn.addEventListener('click', () => {
      if (this.shownSessionId) this.onResume(this.shownSessionId);
    });
    header.append(this.kindBadge, status, this.resumeBtn);

    // Pending-permission banner (the "needs attention" signal).
    this.permsBanner = el('div', 'perms-banner hidden');

    // Workspace disclosure (Claude today) — collapsed, self-hiding.
    this.wsDisclosure = document.createElement('details');
    this.wsDisclosure.className = 'ws-disclosure hidden';
    this.wsSummary = document.createElement('summary');
    this.wsSummary.className = 'ws-summary';
    this.wsBody = el('div', 'ws-body');
    this.wsDisclosure.append(this.wsSummary, this.wsBody);

    // The conversation thread.
    this.thread = el('div', 'chat-thread');

    // Composer.
    const composer = el('div', 'composer');
    this.input = el('textarea', 'composer-input');
    this.input.rows = 1;
    this.input.placeholder = 'Message the agent…  (⌘/Ctrl+Enter)';
    this.input.addEventListener('input', () => this.autoGrow());
    this.input.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        void this.submit();
      }
    });
    const composerRow = el('div', 'composer-row');
    this.sendBtn = el('button', 'composer-send', 'Send');
    this.sendBtn.type = 'button';
    this.sendBtn.addEventListener('click', () => void this.submit());
    this.receiptBox = el('div', 'composer-receipt');
    composerRow.append(this.receiptBox, this.sendBtn);
    composer.append(this.input, composerRow);

    root.append(header, this.permsBanner, this.wsDisclosure, this.thread, composer);

    this.elapsedTimer = setInterval(() => this.renderStatus(), 1000);
  }

  /** Show/refresh the panel for one session. A different id resets the composer. */
  render(
    runtimeSessionId: string,
    agentKind: string,
    msg: AgentStateMessage | undefined,
    events: AgentEventEnvelope[],
    workspace: WorkspacePanelData | undefined,
    exited: boolean,
    canResume: boolean,
  ): void {
    const switched = runtimeSessionId !== this.shownSessionId;
    if (switched) {
      this.shownSessionId = runtimeSessionId;
      this.resetComposer();
    }
    this.agentKind = agentKind;
    this.root.classList.remove('hidden');

    this.kindBadge.textContent = agentKind;
    this.kindBadge.dataset.kind = agentKind;
    this.resumeBtn.classList.toggle('hidden', !(exited && canResume));

    // Status pill from lifecycle + active turn.
    const state = msg?.state;
    this.activeTurnStartedAt = state?.activeTurn ? Date.parse(state.activeTurn.startedAt) : undefined;
    this.turnLabel = state?.activeTurn?.id ?? '';
    this.lifecycle = state?.lifecycle ?? 'preparing';
    this.exited = exited;
    this.renderStatus();

    this.renderPerms(state?.permissions ?? []);
    this.renderWorkspace(workspace);
    this.renderThread(events, switched);
  }

  private lifecycle = 'preparing';
  private exited = false;

  private renderStatus(): void {
    const active = this.activeTurnStartedAt !== undefined;
    let label: string;
    let tone: string;
    if (active) {
      const secs = Math.max(0, Math.round((Date.now() - this.activeTurnStartedAt!) / 1000));
      label = `working · ${secs}s`;
      tone = 'working';
    } else if (this.lifecycle === 'exited' || this.lifecycle === 'failed' || this.exited) {
      label = this.lifecycle === 'failed' ? 'failed' : 'exited';
      tone = 'exited';
    } else if (this.lifecycle === 'ready') {
      label = 'ready';
      tone = 'ready';
    } else {
      label = this.lifecycle;
      tone = 'idle';
    }
    this.statusText.textContent = this.turnLabel && active ? `${label} · ${this.turnLabel}` : label;
    this.statusDot.dataset.tone = tone;
    this.root.dataset.busy = active ? '1' : '0';
  }

  private renderPerms(perms: { tool?: string; requestId: string }[]): void {
    if (perms.length === 0) {
      this.permsBanner.classList.add('hidden');
      return;
    }
    this.permsBanner.classList.remove('hidden');
    const names = perms.map((p) => p.tool ?? p.requestId).join(', ');
    this.permsBanner.replaceChildren(
      el('span', 'perms-icon', '⚠'),
      el('span', 'perms-text', `Waiting for permission: ${names}`),
    );
  }

  private renderThread(events: AgentEventEnvelope[], switched: boolean): void {
    // Preserve auto-scroll: stick to the bottom unless the user scrolled up.
    const nearBottom = switched || this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 40;

    const items = buildThread(events);
    this.thread.replaceChildren();

    if (items.length === 0) {
      this.thread.append(el('div', 'thread-empty', 'No messages yet. Send one below to get started.'));
    }

    for (const item of items) {
      const row = el('div', `msg ${item.kind}${item.error ? ' error' : ''}`);
      if (item.kind === 'note') {
        row.append(el('div', 'msg-note', item.text));
        this.thread.append(row);
        continue;
      }
      const label = el('div', 'msg-role');
      if (item.kind === 'user') {
        label.textContent = 'you';
      } else {
        label.textContent = this.agentKind;
        label.dataset.kind = this.agentKind;
      }
      row.append(label);

      const body = el('div', 'msg-body');
      if (item.text) body.append(el('div', 'msg-text', item.text));

      if (item.tools.length > 0) {
        const tools = el('div', 'msg-tools');
        for (const t of item.tools) {
          const chip = el('span', `tool-chip ${t.status}`);
          chip.append(el('span', 'tool-ic', TOOL_ICON[t.status]), el('span', 'tool-nm', t.name));
          tools.append(chip);
        }
        body.append(tools);
      }

      if (item.streaming) body.append(el('span', 'stream-cursor', '▍'));
      if (!item.text && item.tools.length === 0 && item.streaming) {
        body.append(el('span', 'thinking', 'thinking…'));
      }
      row.append(body);
      this.thread.append(row);
    }

    if (nearBottom) this.thread.scrollTop = this.thread.scrollHeight;
  }

  private renderWorkspace(data: WorkspacePanelData | undefined): void {
    if (!data) {
      this.wsDisclosure.classList.add('hidden');
      return;
    }
    this.wsDisclosure.classList.remove('hidden');
    const { info, diff, final } = data;

    const files = final ? final.metadata.filesTouched : (diff?.filesTouched ?? []);
    this.wsSummary.replaceChildren(
      el('span', 'ws-tag', info.isolation),
      el('span', 'ws-branch', info.branch ?? ''),
      el('span', 'ws-count', `${files.length} file${files.length === 1 ? '' : 's'}`),
    );

    this.wsBody.replaceChildren();
    const root = el('div', 'ws-root', truncatePath(info.root));
    root.title = info.root;
    this.wsBody.append(root);

    const commit = final?.metadata.finalCommit ?? info.initialCommit;
    if (commit) this.wsBody.append(el('div', 'ws-commit', `${final ? 'final' : 'base'} ${commit.slice(0, 8)}`));
    if (data.note) this.wsBody.append(el('div', 'ws-note', data.note));
    if (final?.retained) {
      this.wsBody.append(el('div', 'ws-retained', `worktree retained — ${final.reason ?? 'uncommitted changes kept'}`));
    }

    if (files.length > 0) {
      const list = el('ul', 'ws-files');
      for (const f of files.slice(0, WS_FILES_MAX)) {
        const li = el('li', 'ws-file', f);
        li.title = f;
        list.append(li);
      }
      if (files.length > WS_FILES_MAX) {
        list.append(el('li', 'ws-file more', `… +${files.length - WS_FILES_MAX} more`));
      }
      this.wsBody.append(list);
    }
  }

  /** Hide the panel (the active tab is not an agent session). */
  hide(): void {
    this.shownSessionId = undefined;
    this.root.classList.add('hidden');
  }

  /** The session this panel is currently showing, if any. */
  get sessionId(): string | undefined {
    return this.shownSessionId;
  }

  dispose(): void {
    clearInterval(this.elapsedTimer);
  }

  private autoGrow(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 140)}px`;
  }

  private resetComposer(): void {
    this.input.value = '';
    this.input.style.height = 'auto';
    this.input.disabled = false;
    this.sendBtn.disabled = false;
    this.receiptBox.textContent = '';
    this.receiptBox.className = 'composer-receipt';
  }

  private async submit(): Promise<void> {
    const sessionId = this.shownSessionId;
    if (!sessionId || this.sendBtn.disabled) return;
    const text = this.input.value;
    if (text.trim().length === 0) return;

    this.sendBtn.disabled = true;
    this.input.disabled = true;
    this.receiptBox.className = 'composer-receipt pending';
    this.receiptBox.textContent = 'sending…';

    let receipt: PromptReceipt;
    try {
      receipt = await this.onSubmit(sessionId, text);
    } catch (err) {
      receipt = { status: 'rejected', reason: err instanceof Error ? err.message : String(err) };
    }

    // Only paint the receipt if we are still showing the session it belongs to.
    if (this.shownSessionId !== sessionId) return;
    this.receiptBox.className = `composer-receipt ${receipt.status}`;
    this.receiptBox.textContent = receipt.status === 'confirmed' ? 'sent' : `${receipt.status}: ${receipt.reason}`;
    this.input.disabled = false;
    this.sendBtn.disabled = false;
    if (receipt.status === 'confirmed') {
      this.input.value = '';
      this.input.style.height = 'auto';
    }
  }
}
