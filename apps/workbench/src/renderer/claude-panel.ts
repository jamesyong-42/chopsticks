/**
 * Claude activity panel (DESIGN §12.2 renderer, §19 observation surface).
 *
 * A single right-hand panel that renders the ACTIVE Claude tab from the latest
 * serialized reducer snapshot the main process pushes. The renderer never holds
 * a live ClaudeSession — only these snapshots and a bounded event tail — so this
 * component is pure presentation plus one control affordance: the prompt-
 * injection box, whose Send routes back through `submitPrompt`.
 *
 * The info sections re-render on every state push; the inject box is rebuilt
 * only on a session switch, so a state update never wipes what the user is
 * typing or the last receipt.
 */

import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import type { AgentStateMessage, PromptReceipt } from '../protocol.js';

const EVENT_TAIL_MAX = 50;
const ASSISTANT_TRUNCATE = 280;

type SubmitFn = (runtimeSessionId: string, text: string) => Promise<PromptReceipt>;

/** Trim + collapse whitespace for a compact one-liner in the event tail. */
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
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

export class ClaudePanel {
  private shownSessionId: string | undefined;
  private assistantExpanded = false;

  // Fixed skeleton nodes, built once, updated in place.
  private readonly badge: HTMLSpanElement;
  private readonly obs: HTMLSpanElement;
  private readonly turnLine: HTMLDivElement;
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
  ) {
    root.classList.add('activity');

    const header = el('div', 'panel-header');
    this.badge = el('span', 'badge');
    this.obs = el('span', 'obs');
    header.append(this.badge, this.obs);

    this.turnLine = el('div', 'panel-turn');

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

    root.append(header, this.turnLine, toolsSection, this.permsSection, assistantSection, eventsSection, inject);

    this.elapsedTimer = setInterval(() => this.renderTurn(), 1000);
  }

  private lastAssistant: string | undefined;

  /** Show/refresh the panel for one session. A different id resets the inject box. */
  render(runtimeSessionId: string, msg: AgentStateMessage | undefined, events: AgentEventEnvelope[]): void {
    if (runtimeSessionId !== this.shownSessionId) {
      this.shownSessionId = runtimeSessionId;
      this.assistantExpanded = false;
      this.resetInject();
    }
    this.root.classList.remove('hidden');
    this.renderState(msg);
    this.renderEvents(events);
  }

  /** Hide the panel (active tab is not a Claude session). */
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
