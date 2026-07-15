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
  /** Text came from an authoritative (transcript) source, not a display delta. */
  authoritative: boolean;
  tools: ToolChip[];
  streaming: boolean;
  error?: boolean;
}

/**
 * Rebuild an ordered chat thread from the bounded event tail.
 *
 * One bubble per ASSISTANT MESSAGE, not per turn: a single turn routinely emits
 * several messages (intro → tool → answer), and each deserves its own bubble in
 * arrival order, exactly as the native TUI shows them.
 *
 * SINGLE SOURCE for message bubbles. A Claude message reaches us TWICE — from the
 * hook (`MessageDisplay`, streaming) and from the transcript observer
 * (authoritative text). Their `message_id` spaces do NOT align (hook display id
 * vs. the transcript's `msg_…` API id), so the two copies cannot be reconciled in
 * the renderer and rendering both is the duplication we kept seeing. Per the
 * design's own fork (HOOK-SURFACE-FINDINGS §7), we take ONE: the hook/structured
 * stream, which streams live and shares the id space Codex and ACP already use.
 * Transcript-sourced `assistant.message` stays authoritative for session STATE
 * but is excluded from the thread here. `turn.completed` only materializes a
 * bubble when the turn produced no assistant message at all.
 *
 * The collapse trap: ACP (Grok) may reuse a constant `messageId` ('acp-msg')
 * across turns, so a bare messageId key would fuse unrelated turns. We therefore
 * remember each message's turn and only reuse a bubble when the turns match.
 * Tools are tracked by call-id (so completion updates the right chip) and attach
 * to the message bubble that was open when they fired.
 */
export function buildThread(events: AgentEventEnvelope[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  const byMessage = new Map<string, { item: ThreadItem; turn?: string }>();
  const chipById = new Map<string, ToolChip>();
  let lastAssistant: ThreadItem | undefined;

  const turnKeyOf = (env: AgentEventEnvelope, e: { turnId?: string }): string | undefined =>
    env.promptId ?? env.turnId ?? e.turnId;

  const newAssistant = (turn: string | undefined): ThreadItem => {
    const a: ThreadItem = { kind: 'assistant', turnId: turn, text: '', authoritative: false, tools: [], streaming: true };
    items.push(a);
    lastAssistant = a;
    return a;
  };

  // The bubble a turn-anchored, message-less event (a tool call) belongs to: the
  // open bubble of this same turn, else a fresh one.
  const turnBubble = (turn: string | undefined): ThreadItem =>
    lastAssistant && (lastAssistant.turnId === turn || turn === undefined) ? lastAssistant : newAssistant(turn);

  for (const env of events) {
    const e = env.event as Record<string, unknown> & { type: string };
    const turnKey = turnKeyOf(env, e as { turnId?: string });
    switch (e.type) {
      case 'turn.started':
        if (typeof e.prompt === 'string' && e.prompt.trim()) {
          items.push({ kind: 'user', turnId: turnKey, text: e.prompt, authoritative: true, tools: [], streaming: false });
        }
        break;
      case 'assistant.message': {
        // Transcript copy: authoritative for state, but a duplicate here — its
        // id space can't be reconciled with the hook stream. Hook drives bubbles.
        if (env.source === 'native-transcript') break;
        const messageId = typeof e.messageId === 'string' ? e.messageId : undefined;
        let a: ThreadItem | undefined;
        if (messageId) {
          const ex = byMessage.get(messageId);
          // Reuse when it's the same turn, or when this copy has no turn of its
          // own (transcript), or when the remembered copy hadn't learned its turn.
          if (ex && (ex.turn === turnKey || turnKey === undefined || ex.turn === undefined)) {
            a = ex.item;
            if (turnKey !== undefined && ex.turn === undefined) ex.turn = turnKey;
          }
          if (!a) {
            a = newAssistant(turnKey);
            byMessage.set(messageId, { item: a, turn: turnKey });
          }
        } else {
          a = turnBubble(turnKey);
        }
        lastAssistant = a;
        if (turnKey !== undefined && a.turnId === undefined) a.turnId = turnKey;
        const authoritative = e.displayOnly === false;
        if ((authoritative || !a.authoritative) && typeof e.text === 'string') a.text = e.text;
        if (authoritative) a.authoritative = true;
        a.streaming = e.final === false;
        break;
      }
      case 'tool.requested':
      case 'tool.started': {
        const id = String(e.toolCallId ?? '');
        if (!chipById.has(id)) {
          const chip: ToolChip = { id, name: String(e.tool || id || 'tool'), status: 'running' };
          chipById.set(id, chip);
          turnBubble(turnKey).tools.push(chip);
        }
        break;
      }
      case 'tool.completed':
      case 'tool.failed': {
        const id = String(e.toolCallId ?? '');
        const status = e.type === 'tool.failed' ? 'failed' : 'done';
        const chip = chipById.get(id);
        if (chip) chip.status = status;
        else {
          const created: ToolChip = { id, name: String(e.tool || id || 'tool'), status };
          chipById.set(id, created);
          turnBubble(turnKey).tools.push(created);
        }
        break;
      }
      case 'turn.completed': {
        // Seal every assistant bubble of this turn; only synthesize one from the
        // final text when the turn produced no assistant message at all.
        let sealed = false;
        for (const item of items) {
          if (item.kind === 'assistant' && item.turnId === turnKey) {
            item.streaming = false;
            sealed = true;
          }
        }
        if (!sealed && typeof e.lastAssistantMessage === 'string' && e.lastAssistantMessage) {
          const a = newAssistant(turnKey);
          a.text = e.lastAssistantMessage;
          a.authoritative = true;
          a.streaming = false;
        }
        break;
      }
      case 'turn.failed': {
        for (const item of items) {
          if (item.kind === 'assistant' && item.turnId === turnKey) item.streaming = false;
        }
        items.push({
          kind: 'note',
          text: `turn failed${e.error ? `: ${e.error}` : ''}`,
          authoritative: true,
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
            authoritative: true,
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
    } else if (this.lifecycle === 'failed') {
      label = 'failed';
      tone = 'failed';
    } else if (this.lifecycle === 'exited' || this.exited) {
      label = 'exited';
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
