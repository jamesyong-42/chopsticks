/**
 * Agent chat panel (DESIGN §12.2 renderer, §19 observation surface).
 *
 * A conversation view over the active agent tab. The renderer never holds a
 * live `AgentSession`; it gets a serialized reducer snapshot plus the runtime's
 * provider-neutral conversation projection. On top of that presentation sits
 * the one control affordance: the composer, whose Send routes back through
 * `submitPrompt`.
 *
 * The thread is rendered by React while the composer remains a separate element,
 * so state pushes never wipe what the user is typing. The status pill's elapsed
 * timer updates on its own without touching the thread.
 *
 * The optional git workspace is a
 * collapsible disclosure that hides itself when there is no workspace data.
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConversationSnapshot } from '@vibecook/chopsticks-runtime';
import type {
  AgentStateMessage,
  PromptReceipt,
  WorkspaceDiff,
  WorkspaceFinalEvent,
  WorkspaceInfo,
} from '../protocol.js';
import { ConversationThread } from './components/ConversationThread.js';

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

const EMPTY_CONVERSATION: AgentConversationSnapshot = { items: [], responding: false };

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
  private readonly threadRoot: Root;
  // Composer
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly receiptBox: HTMLDivElement;

  // Live turn ticker: only the status pill updates on tick, never the thread.
  private activeTurnStartedAt: number | undefined;
  private liveLabel = '';
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

    // Workspace disclosure — collapsed and self-hiding.
    this.wsDisclosure = document.createElement('details');
    this.wsDisclosure.className = 'ws-disclosure hidden';
    this.wsSummary = document.createElement('summary');
    this.wsSummary.className = 'ws-summary';
    this.wsBody = el('div', 'ws-body');
    this.wsDisclosure.append(this.wsSummary, this.wsBody);

    // The conversation thread.
    this.thread = el('div', 'chat-thread');
    this.threadRoot = createRoot(this.thread);

    // Composer.
    const composer = el('div', 'composer');
    this.input = el('textarea', 'composer-input');
    this.input.rows = 1;
    this.input.placeholder = 'Message the agent…';
    this.input.addEventListener('input', () => this.autoGrow());
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
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
    const conversation = msg?.conversation ?? EMPTY_CONVERSATION;
    const activeTool = state?.tools.find((tool) => tool.state === 'running' || tool.state === 'requested');
    this.liveLabel = state?.permissions.length
      ? 'Waiting for permission'
      : activeTool
        ? (activeTool.presentation?.title ?? `Using ${activeTool.tool ?? 'tool'}`)
        : state?.activeReasoning
          ? 'Thinking'
          : conversation.responding
            ? 'Responding'
            : state?.activeTurn
              ? 'Working'
              : '';
    const activityStartedAt = state?.activeReasoning?.startedAt ?? state?.activeTurn?.startedAt;
    this.activeTurnStartedAt = activityStartedAt ? Date.parse(activityStartedAt) : undefined;
    this.lifecycle = state?.lifecycle ?? 'preparing';
    this.exited = exited;
    this.renderStatus();

    this.renderPerms(state?.permissions ?? []);
    this.renderWorkspace(workspace);
    this.renderThread(conversation, switched, Boolean(state?.activeTurn));
  }

  private lifecycle = 'preparing';
  private exited = false;

  private renderStatus(): void {
    const active = this.activeTurnStartedAt !== undefined || Boolean(this.liveLabel);
    let label: string;
    let tone: string;
    if (active) {
      const secs = this.activeTurnStartedAt
        ? Math.max(0, Math.round((Date.now() - this.activeTurnStartedAt) / 1000))
        : 0;
      label = `${this.liveLabel || 'Working'} · ${secs}s`;
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
    this.statusText.textContent = label;
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

  private renderThread(conversation: AgentConversationSnapshot, switched: boolean, workingFallback: boolean): void {
    // Preserve auto-scroll: stick to the bottom unless the user scrolled up.
    const nearBottom = switched || this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 40;

    this.threadRoot.render(
      createElement(ConversationThread, { conversation, agentKind: this.agentKind, workingFallback }),
    );
    if (nearBottom) requestAnimationFrame(() => (this.thread.scrollTop = this.thread.scrollHeight));
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
      el('span', 'ws-tag', info.mode),
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
    this.threadRoot.unmount();
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
    this.receiptBox.textContent = 'Enter to send · Shift+Enter for newline';
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
