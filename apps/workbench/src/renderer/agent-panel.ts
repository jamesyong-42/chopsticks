/**
 * Agent activity panel (DESIGN §12.2 renderer, §19 observation surface).
 *
 * ONE right-hand panel that renders the ACTIVE agent tab — Claude, Codex, or
 * Grok, uniformly — from the latest serialized reducer snapshot main pushes. The
 * renderer never holds a live `AgentSession`; only these snapshots + a bounded
 * event tail. So this is pure presentation over the AGENT-AGNOSTIC common ground:
 *
 *   observe → lifecycle badge · active turn · in-flight tools · pending
 *             permissions · last assistant message · event tail
 *   control → the prompt-injection box (Send → `submitPrompt`) + Resume
 *
 * Every one of those is driven by core `AgentSession` snapshot types, so the
 * panel is identical for all agents. The ONE agent-specific extra is the
 * workspace section (a git worktree/diff), shown only for agents that supply it
 * (Claude today); it hides itself when the data is absent.
 *
 * The info sections re-render on every state push; the inject box is rebuilt only
 * on a session switch, so a state update never wipes what the user is typing or
 * the last receipt.
 */

import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import type {
  AgentStateMessage,
  PromptReceipt,
  WorkspaceDiff,
  WorkspaceFinalEvent,
  WorkspaceInfo,
} from '../protocol.js';

const EVENT_TAIL_MAX = 50;
const ASSISTANT_TRUNCATE = 280;
const WS_FILES_MAX = 12;

type SubmitFn = (runtimeSessionId: string, text: string) => Promise<PromptReceipt>;
type ResumeFn = (runtimeSessionId: string) => void;

/**
 * The renderer's view of one session's workspace: the info known at creation, the
 * latest live diff (live poll / agent-state piggyback), and the final record once
 * the session exits (which also carries a retained-worktree notice).
 */
export interface WorkspacePanelData {
  info: WorkspaceInfo;
  diff?: WorkspaceDiff;
  final?: WorkspaceFinalEvent;
  /** Set on a resumed session that had to fall back (e.g. its worktree was gone). */
  note?: string;
}

/** Trim + collapse whitespace for a compact one-liner in the event tail. */
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Keep a path readable: an over-long root shows its tail with a leading ellipsis. */
function truncatePath(p: string, max = 42): string {
  return p.length <= max ? p : '…' + p.slice(p.length - (max - 1));
}

/** A short, human summary of an envelope for the scrolling tail. */
function summarizeEvent(envelope: AgentEventEnvelope): string {
  const e = envelope.event as Record<string, unknown> & { type: string };
  switch (e.type) {
    case 'turn.started':
      return typeof e.prompt === 'string' ? `“${oneLine(e.prompt)}”` : '';
    case 'turn.completed':
      return typeof e.lastAssistantMessage === 'string' ? oneLine(e.lastAssistantMessage) : '';
    case 'assistant.message':
      return typeof e.text === 'string' ? oneLine(e.text) : '';
    case 'tool.requested':
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return [e.tool, e.toolCallId].filter(Boolean).join(' ');
    case 'permission.requested':
    case 'permission.resolved':
      return [e.tool, e.requestId].filter(Boolean).join(' ');
    case 'subagent.started':
    case 'subagent.stopped':
      return [e.agentType, e.subagentId].filter(Boolean).join(' ');
    case 'task.created':
    case 'task.completed':
      return typeof e.description === 'string' ? oneLine(e.description) : String(e.taskId ?? '');
    case 'session.exited':
    case 'process.exited':
      return String(e.reason ?? '');
    default:
      return '';
  }
}

/** Compact human key/value summary of a tool/permission input object. */
function summarizeInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input);
  if (typeof input !== 'object') return oneLine(String(input));
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).slice(0, 4)) {
    const v = obj[key];
    parts.push(`${key}=${oneLine(typeof v === 'string' ? v : JSON.stringify(v), 40)}`);
  }
  return parts.join(' ');
}

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

export class AgentPanel {
  private shownSessionId: string | undefined;
  private assistantExpanded = false;

  // Fixed skeleton nodes, built once, updated in place.
  private readonly kindBadge: HTMLSpanElement;
  private readonly badge: HTMLSpanElement;
  private readonly obs: HTMLSpanElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly turnLine: HTMLDivElement;
  // Workspace section (agent-specific extra; Claude today).
  private readonly wsSection: HTMLElement;
  private readonly wsBadge: HTMLSpanElement;
  private readonly wsBranch: HTMLSpanElement;
  private readonly wsRoot: HTMLDivElement;
  private readonly wsCommit: HTMLDivElement;
  private readonly wsNote: HTMLDivElement;
  private readonly wsRetained: HTMLDivElement;
  private readonly wsFilesHeading: HTMLHeadingElement;
  private readonly wsFiles: HTMLUListElement;
  private readonly toolsList: HTMLUListElement;
  private readonly permsSection: HTMLElement;
  private readonly permsList: HTMLUListElement;
  private readonly assistantBox: HTMLDivElement;
  private readonly eventTail: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly receiptBox: HTMLDivElement;

  // Elapsed ticker for the active turn.
  private activeTurnStartedAt: number | undefined;
  private readonly elapsedTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly root: HTMLElement,
    private readonly onSubmit: SubmitFn,
    private readonly onResume: ResumeFn,
  ) {
    root.classList.add('activity');

    const header = el('div', 'panel-header');
    // Which agent this panel is showing (claude / codex / grok); colored via CSS.
    this.kindBadge = el('span', 'kind-badge');
    this.badge = el('span', 'badge');
    this.obs = el('span', 'obs');
    // Resume: shown only on an exited tab with a resumable id. Click reconstructs
    // the spawn (a new tab reopening the same agent session) via onResume.
    this.resumeBtn = el('button', 'resume-btn', '⟲ Resume');
    this.resumeBtn.type = 'button';
    this.resumeBtn.classList.add('hidden');
    this.resumeBtn.addEventListener('click', () => {
      if (this.shownSessionId) this.onResume(this.shownSessionId);
    });
    header.append(this.kindBadge, this.badge, this.obs, this.resumeBtn);

    this.turnLine = el('div', 'panel-turn');

    // Workspace: isolation badge + branch, root path, commit, retained notice,
    // and the files-touched list. Hidden until an agent supplies its data (only
    // agents with a git workspace — Claude — do; Codex/Grok pass none).
    this.wsSection = el('section', 'panel-section workspace-section');
    const wsHeader = el('div', 'ws-header');
    wsHeader.append(el('h4', undefined, 'Workspace'));
    this.wsBadge = el('span', 'ws-badge');
    this.wsBranch = el('span', 'ws-branch');
    wsHeader.append(this.wsBadge, this.wsBranch);
    this.wsRoot = el('div', 'ws-root');
    this.wsCommit = el('div', 'ws-commit');
    this.wsNote = el('div', 'ws-note');
    this.wsRetained = el('div', 'ws-retained');
    this.wsFilesHeading = el('h5', 'ws-files-heading', 'Files touched');
    this.wsFiles = el('ul', 'ws-files');
    this.wsSection.append(
      wsHeader,
      this.wsRoot,
      this.wsCommit,
      this.wsNote,
      this.wsRetained,
      this.wsFilesHeading,
      this.wsFiles,
    );

    const toolsSection = el('section', 'panel-section');
    toolsSection.append(el('h4', undefined, 'In-flight tools'));
    this.toolsList = el('ul', 'tools');
    toolsSection.append(this.toolsList);

    this.permsSection = el('section', 'panel-section perms-section');
    this.permsSection.append(el('h4', undefined, 'Pending permissions'));
    this.permsList = el('ul', 'perms');
    this.permsSection.append(this.permsList);

    const assistantSection = el('section', 'panel-section');
    assistantSection.append(el('h4', undefined, 'Last assistant message'));
    this.assistantBox = el('div', 'assistant-msg');
    this.assistantBox.addEventListener('click', () => {
      this.assistantExpanded = !this.assistantExpanded;
      this.renderAssistant(this.lastAssistant);
    });
    assistantSection.append(this.assistantBox);

    const eventsSection = el('section', 'panel-section events-section');
    eventsSection.append(el('h4', undefined, 'Events'));
    this.eventTail = el('div', 'event-tail');
    eventsSection.append(this.eventTail);

    const inject = el('div', 'panel-inject');
    this.input = el('textarea', 'inject-input');
    this.input.placeholder = 'Inject a prompt… (⌘/Ctrl+Enter to send)';
    this.input.rows = 2;
    this.sendBtn = el('button', 'inject-send', 'Send');
    this.sendBtn.type = 'button';
    this.receiptBox = el('div', 'inject-receipt');
    this.sendBtn.addEventListener('click', () => void this.submit());
    this.input.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        void this.submit();
      }
    });
    inject.append(this.input, this.sendBtn, this.receiptBox);

    root.append(
      header,
      this.turnLine,
      this.wsSection,
      toolsSection,
      this.permsSection,
      assistantSection,
      eventsSection,
      inject,
    );

    this.elapsedTimer = setInterval(() => this.renderTurn(), 1000);
  }

  private lastAssistant: string | undefined;

  /** Show/refresh the panel for one session. A different id resets the inject box. */
  render(
    runtimeSessionId: string,
    agentKind: string,
    msg: AgentStateMessage | undefined,
    events: AgentEventEnvelope[],
    workspace: WorkspacePanelData | undefined,
    exited: boolean,
    canResume: boolean,
  ): void {
    if (runtimeSessionId !== this.shownSessionId) {
      this.shownSessionId = runtimeSessionId;
      this.assistantExpanded = false;
      this.resetInject();
    }
    this.root.classList.remove('hidden');
    // Identity: which agent this is (colored via CSS data-kind).
    this.kindBadge.textContent = agentKind;
    this.kindBadge.dataset.kind = agentKind;
    // Resume is offered on an exited tab that has a resumable id; a live tab
    // hides it. Applies to every agent (Claude --session-id, Codex thread, Grok id).
    this.resumeBtn.classList.toggle('hidden', !(exited && canResume));
    this.renderState(msg);
    this.renderWorkspace(workspace);
    this.renderEvents(events);
  }

  private renderWorkspace(data: WorkspacePanelData | undefined): void {
    if (!data) {
      this.wsSection.classList.add('hidden');
      return;
    }
    this.wsSection.classList.remove('hidden');
    const { info, diff, final } = data;

    this.wsBadge.textContent = info.isolation;
    this.wsBadge.dataset.isolation = info.isolation;

    this.wsBranch.textContent = info.branch ?? '';
    this.wsBranch.classList.toggle('hidden', !info.branch);

    // Root path: truncated head; full value lives in the title attr.
    this.wsRoot.textContent = truncatePath(info.root);
    this.wsRoot.title = info.root;

    // Commit: final short-sha once exited, otherwise the base commit.
    const commit = final?.metadata.finalCommit ?? info.initialCommit;
    this.wsCommit.textContent = commit ? `${final ? 'final' : 'base'} ${commit.slice(0, 8)}` : '';
    this.wsCommit.classList.toggle('hidden', !commit);

    // Resume-fallback note (e.g. the original worktree was gone, so this resumed
    // session runs on the repo root instead).
    this.wsNote.textContent = data.note ?? '';
    this.wsNote.classList.toggle('hidden', !data.note);

    // Retained-worktree notice: highlighted, only when a dirty worktree was kept.
    const retained = final?.retained ?? false;
    this.wsRetained.textContent = retained ? `worktree retained — ${final?.reason ?? 'uncommitted changes kept'}` : '';
    this.wsRetained.classList.toggle('hidden', !retained);

    // Files touched: final metadata after exit, else the latest live diff.
    const files = final ? final.metadata.filesTouched : (diff?.filesTouched ?? []);
    this.wsFilesHeading.textContent = final ? 'Files touched (final)' : 'Files touched';
    this.wsFiles.replaceChildren();
    if (files.length === 0) {
      this.wsFiles.append(el('li', 'empty', final ? 'none' : '—'));
    } else {
      for (const f of files.slice(0, WS_FILES_MAX)) {
        const li = el('li', 'ws-file', f);
        li.title = f;
        this.wsFiles.append(li);
      }
      if (files.length > WS_FILES_MAX) {
        this.wsFiles.append(el('li', 'ws-file more', `… +${files.length - WS_FILES_MAX} more`));
      }
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

  private renderState(msg: AgentStateMessage | undefined): void {
    const state = msg?.state;
    const lifecycle = state?.lifecycle ?? 'preparing';
    this.badge.textContent = lifecycle;
    this.badge.dataset.lifecycle = lifecycle;
    this.obs.textContent = msg?.observationLevel ?? 'terminal-only';

    this.activeTurnStartedAt = state?.activeTurn ? Date.parse(state.activeTurn.startedAt) : undefined;
    this.renderTurn(state?.activeTurn?.id);

    // In-flight tools.
    this.toolsList.replaceChildren();
    const tools = state?.tools ?? [];
    if (tools.length === 0) {
      this.toolsList.append(el('li', 'empty', 'none'));
    } else {
      for (const t of tools) {
        const li = el('li');
        li.append(el('span', 'tool-name', t.tool ?? t.toolCallId));
        li.append(el('span', 'tool-state', t.state));
        const inSummary = summarizeInput(t.input);
        if (inSummary) li.append(el('span', 'tool-input', inSummary));
        this.toolsList.append(li);
      }
    }

    // Pending permissions — the "needs attention" signal.
    this.permsList.replaceChildren();
    const perms = state?.permissions ?? [];
    this.permsSection.classList.toggle('active', perms.length > 0);
    if (perms.length === 0) {
      this.permsList.append(el('li', 'empty', 'none'));
    } else {
      for (const p of perms) {
        const li = el('li');
        li.append(el('span', 'perm-name', p.tool ?? p.requestId));
        this.permsList.append(li);
      }
    }

    this.lastAssistant = state?.lastAssistantMessage;
    this.renderAssistant(this.lastAssistant);
  }

  private renderTurn(idOverride?: string): void {
    if (this.activeTurnStartedAt === undefined) {
      this.turnLine.textContent = 'no active turn';
      this.turnLine.classList.remove('active');
      return;
    }
    const secs = Math.max(0, Math.round((Date.now() - this.activeTurnStartedAt) / 1000));
    const id = idOverride ?? this.currentTurnId ?? '';
    this.currentTurnId = id;
    this.turnLine.textContent = `turn ${id || '?'} · ${secs}s`;
    this.turnLine.classList.add('active');
  }

  private currentTurnId: string | undefined;

  private renderAssistant(text: string | undefined): void {
    if (!text) {
      this.assistantBox.textContent = '—';
      this.assistantBox.classList.remove('expandable');
      return;
    }
    const long = text.length > ASSISTANT_TRUNCATE;
    if (long && !this.assistantExpanded) {
      this.assistantBox.textContent = text.slice(0, ASSISTANT_TRUNCATE) + ' … (more)';
    } else {
      this.assistantBox.textContent = long ? text + ' (less)' : text;
    }
    this.assistantBox.classList.toggle('expandable', long);
  }

  private renderEvents(events: AgentEventEnvelope[]): void {
    const tail = events.slice(-EVENT_TAIL_MAX);
    this.eventTail.replaceChildren();
    for (const envelope of tail) {
      const row = el('div', 'event-row');
      row.append(el('span', 'ev-seq', `#${envelope.sequence}`));
      row.append(el('span', 'ev-type', (envelope.event as { type: string }).type));
      row.append(el('span', 'ev-source', envelope.source));
      const summary = summarizeEvent(envelope);
      if (summary) row.append(el('span', 'ev-summary', summary));
      this.eventTail.append(row);
    }
    // Keep the newest line in view.
    this.eventTail.scrollTop = this.eventTail.scrollHeight;
  }

  private resetInject(): void {
    this.input.value = '';
    this.input.disabled = false;
    this.sendBtn.disabled = false;
    this.receiptBox.textContent = '';
    this.receiptBox.className = 'inject-receipt';
  }

  private async submit(): Promise<void> {
    const sessionId = this.shownSessionId;
    if (!sessionId || this.sendBtn.disabled) return;
    const text = this.input.value;
    if (text.trim().length === 0) return;

    this.sendBtn.disabled = true;
    this.input.disabled = true;
    this.receiptBox.className = 'inject-receipt pending';
    this.receiptBox.textContent = 'submitting…';

    let receipt: PromptReceipt;
    try {
      receipt = await this.onSubmit(sessionId, text);
    } catch (err) {
      receipt = { status: 'rejected', reason: err instanceof Error ? err.message : String(err) };
    }

    // The session may have changed while the promise was in flight; only paint
    // the receipt if we are still showing the session it belongs to.
    if (this.shownSessionId !== sessionId) return;
    this.receiptBox.className = `inject-receipt ${receipt.status}`;
    this.receiptBox.textContent =
      receipt.status === 'confirmed'
        ? `confirmed${receipt.turnId ? ` (turn ${receipt.turnId})` : ''}`
        : `${receipt.status}: ${receipt.reason}`;
    this.input.disabled = false;
    this.sendBtn.disabled = false;
    if (receipt.status === 'confirmed') this.input.value = '';
  }
}
