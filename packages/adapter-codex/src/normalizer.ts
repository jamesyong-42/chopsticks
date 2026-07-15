/**
 * Codex app-server notification → normalized AgentEvent translation
 * (M5 / draft/CODEX-SURFACE-FINDINGS.md §7).
 *
 * The Codex adapter observes through a STRUCTURED JSON-RPC surface, not hooks +
 * transcript. Where the Claude normalizer parses hook payloads, this one maps
 * `ServerNotification`s (`{ method, params }`) from `codex app-server` onto the
 * same core `AgentEvent` union. The mapping was grounded on a live C1 capture
 * (`probe/codex/c1-appserver-capture.jsonl`).
 *
 * Notable shape differences from Claude, and how they're reconciled:
 * - Codex splits the turn boundary (`turn/started`, carrying the turn id) from
 *   the user's prompt text (the `userMessage` item). We DEFER `turn.started`
 *   until the userMessage arrives so the emitted event carries BOTH id and
 *   prompt — parity with Claude's single `UserPromptSubmit`. A turn with no
 *   userMessage still gets a defensive `turn.started` at `turn/completed`.
 * - Assistant text STREAMS via `item/agentMessage/delta` (keyed by `itemId`);
 *   deltas accumulate and emit `assistant.message` with `final:false`, and the
 *   `item/completed`(agentMessage) emits the authoritative full text with
 *   `final:true`. Unlike Claude's transcript-sourced text, this is authoritative
 *   from the protocol, so `displayOnly:false`.
 * - Reasoning notifications become presence events plus the protocol-designated
 *   summary stream. Raw thought text is never copied into core events; it remains
 *   available only on the envelope's native payload.
 * - Pure infra/account/UI notifications (see AMBIENT) are NOT agent semantics
 *   and are dropped. Everything else unmodeled — token usage and sub-stream
 *   deltas — is RETAINED as `adapter.native-event` (ADR-008), never silently lost.
 *
 * Stateful by necessity (delta accumulation, the deferred-turn join) — one
 * normalizer instance per Codex session.
 */

import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibecook/chopsticks-core';

export interface CodexServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface NormalizedNotification {
  events: AgentEvent[];
  threadId?: string;
  turnId?: string;
  /**
   * The `clientUserMessageId` echoed back on a userMessage item. Set the
   * matching `TurnStartParams.clientUserMessageId` at injection time and match
   * it here for deterministic prompt confirmation (no `uncertain` receipt).
   */
  userMessageClientId?: string | null;
}

/**
 * Out-of-band notifications that are not agent turn semantics: account/plan,
 * MCP server boot, remote-control status, thread status churn (the turn events
 * already model running/idle). Dropped rather than retained to keep the
 * reducer's `unknownEvents` counter meaningful.
 */
const AMBIENT = new Set<string>([
  'remoteControl/status/changed',
  'mcpServer/startupStatus/updated',
  'mcpServer/oauthLogin/completed',
  'account/rateLimits/updated',
  'account/updated',
  'account/login/completed',
  'thread/status/changed',
  'app/list/updated',
  'skills/changed',
]);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Text of an item: agentMessage `text`, or a userMessage's `content` text spans. */
function itemText(item: Record<string, unknown>): string {
  const direct = str(item.text);
  if (direct !== undefined) return direct;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((c) => (rec(c)?.type === 'text' ? (str(rec(c)?.text) ?? '') : '')).join('');
}

function detailOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(' ');
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  } catch {
    return undefined;
  }
}

function presentation(kind: ToolActivityKind, title: string, detail?: unknown): ToolPresentation {
  return { kind, title, detail: detailOf(detail) };
}

export class CodexNotificationNormalizer {
  private messageBuffers = new Map<string, string>();
  private reasoningSummaries = new Map<string, string>();
  private pendingTurn: { turnId?: string; emitted: boolean } | undefined;

  normalize(notif: CodexServerNotification): NormalizedNotification {
    const method = notif.method;
    const p = notif.params ?? {};
    const events: AgentEvent[] = [];
    const threadId = str(p.threadId) ?? str(rec(p.thread)?.id);
    const turnId = str(p.turnId) ?? str(rec(p.turn)?.id) ?? this.pendingTurn?.turnId;
    const result: NormalizedNotification = { events, threadId, turnId };

    const flushTurnStarted = (prompt?: string): void => {
      if (this.pendingTurn && !this.pendingTurn.emitted) {
        events.push({ type: 'turn.started', turnId: this.pendingTurn.turnId, prompt });
        this.pendingTurn.emitted = true;
      }
    };

    const onItem = (item: Record<string, unknown> | undefined, phase: 'started' | 'completed'): void => {
      if (!item) return;
      const itemType = str(item.type);
      const itemId = str(item.id) ?? 'unknown-item';
      switch (itemType) {
        case 'userMessage':
          // The prompt echo — carries the turn's prompt text and the injection
          // confirmation id. Fires turn.started (deferred from turn/started).
          if (phase === 'completed') {
            result.userMessageClientId = (item.clientId ?? null) as string | null;
            flushTurnStarted(itemText(item));
          }
          break;

        case 'agentMessage':
          if (phase === 'completed') {
            this.messageBuffers.delete(itemId);
            events.push({
              type: 'assistant.message',
              messageId: itemId,
              turnId: result.turnId,
              text: itemText(item),
              final: true,
              displayOnly: false,
            });
          }
          break;

        case 'reasoning': {
          if (phase === 'started') {
            events.push({ type: 'reasoning.started', reasoningId: itemId });
          } else {
            const summary = Array.isArray(item.summary)
              ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n')
              : undefined;
            if (summary && summary !== this.reasoningSummaries.get(itemId)) {
              events.push({ type: 'reasoning.summary', reasoningId: itemId, text: summary, final: true });
            }
            this.reasoningSummaries.delete(itemId);
            events.push({ type: 'reasoning.completed', reasoningId: itemId });
          }
          break;
        }

        // UNVERIFIED — the C1 "pong" turn used no tools, so these item types have
        // no captured fixtures yet. Mapped structurally; confirm exact shapes
        // (ids, output fields) with a workspace-write probe (M5 C4).
        case 'commandExecution':
        case 'localShellCall':
          if (phase === 'started') {
            events.push({
              type: 'tool.started',
              toolCallId: itemId,
              tool: 'command',
              input: item.command ?? item.cmd,
              presentation: presentation('command', 'Running command', item.command ?? item.cmd),
            });
          } else {
            events.push({
              type: 'tool.completed',
              toolCallId: itemId,
              tool: 'command',
              output: item.output,
              presentation: presentation('command', 'Ran command', item.command ?? item.cmd),
            });
          }
          break;

        case 'fileChange':
          if (phase === 'started') {
            events.push({
              type: 'tool.started',
              toolCallId: itemId,
              tool: 'apply_patch',
              presentation: presentation('file-edit', 'Editing files', item.changes ?? item.path),
            });
          } else {
            events.push({
              type: 'tool.completed',
              toolCallId: itemId,
              tool: 'apply_patch',
              presentation: presentation('file-edit', 'Edited files', item.changes ?? item.path),
            });
          }
          break;

        case 'webSearch':
          if (phase === 'started') {
            events.push({
              type: 'tool.started',
              toolCallId: itemId,
              tool: 'web_search',
              input: item.query,
              presentation: presentation('web-search', 'Searching the web', item.query),
            });
          } else {
            events.push({
              type: 'tool.completed',
              toolCallId: itemId,
              tool: 'web_search',
              output: item.result,
              presentation: presentation('web-search', 'Searched the web', item.query),
            });
          }
          break;

        case 'mcpToolCall':
          if (phase === 'started') {
            events.push({
              type: 'tool.started',
              toolCallId: itemId,
              tool: str(item.tool) ?? str(item.name) ?? 'mcp',
              input: item.arguments,
              presentation: presentation('mcp', str(item.name) ?? 'Using MCP tool', item.arguments),
            });
          } else {
            events.push({
              type: 'tool.completed',
              toolCallId: itemId,
              tool: str(item.tool) ?? str(item.name) ?? 'mcp',
              output: item.result,
              presentation: presentation('mcp', str(item.name) ?? 'Used MCP tool', item.arguments),
            });
          }
          break;

        default:
          // plan and future item types — retain, don't invent semantics.
          if (phase === 'completed') {
            events.push({
              type: 'adapter.native-event',
              adapter: 'codex',
              nativeType: `item/${itemType ?? 'unknown'}`,
            });
          }
          break;
      }
    };

    switch (method) {
      case 'thread/started': {
        const thread = rec(p.thread);
        events.push({
          type: 'session.started',
          nativeSessionId: str(thread?.id) ?? threadId,
          title: str(thread?.name) ?? (str(thread?.preview) || undefined),
        });
        break;
      }

      case 'turn/started':
        // Defer: the prompt text lands with the userMessage item.
        this.pendingTurn = { turnId: str(rec(p.turn)?.id), emitted: false };
        result.turnId = this.pendingTurn.turnId;
        break;

      case 'item/started':
        onItem(rec(p.item), 'started');
        break;

      case 'item/completed':
        onItem(rec(p.item), 'completed');
        break;

      case 'item/agentMessage/delta': {
        const itemId = str(p.itemId) ?? 'unknown-item';
        const acc = (this.messageBuffers.get(itemId) ?? '') + (str(p.delta) ?? '');
        this.messageBuffers.set(itemId, acc);
        events.push({
          type: 'assistant.message',
          messageId: itemId,
          turnId: result.turnId,
          text: acc,
          final: false,
          displayOnly: false,
        });
        break;
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryPartAdded':
        events.push({ type: 'reasoning.progress', reasoningId: str(p.itemId) });
        break;

      case 'item/reasoning/summaryTextDelta': {
        const itemId = str(p.itemId) ?? 'reasoning';
        const summary = (this.reasoningSummaries.get(itemId) ?? '') + (str(p.delta) ?? '');
        this.reasoningSummaries.set(itemId, summary);
        events.push({ type: 'reasoning.summary', reasoningId: itemId, text: summary, final: false });
        break;
      }

      case 'turn/completed': {
        const turn = rec(p.turn);
        const tId = str(turn?.id) ?? this.pendingTurn?.turnId;
        flushTurnStarted(); // a turn with no userMessage still gets a start boundary
        const status = str(turn?.status);
        const err = turn?.error;
        if (status === 'failed' || (err !== null && err !== undefined)) {
          const error = typeof err === 'string' ? err : str(rec(err)?.message);
          events.push({ type: 'turn.failed', turnId: tId, error });
        } else {
          events.push({ type: 'turn.completed', turnId: tId });
        }
        this.pendingTurn = undefined;
        break;
      }

      case 'error':
        events.push({ type: 'notification', message: str(p.message), notificationType: 'error' });
        break;

      default:
        if (AMBIENT.has(method)) break; // infra / account / UI churn — not agent semantics
        // Session-relevant but unmodeled (token usage, sub-streams):
        // retain per ADR-008 so nothing is silently dropped.
        events.push({ type: 'adapter.native-event', adapter: 'codex', nativeType: method });
        break;
    }

    return result;
  }
}
