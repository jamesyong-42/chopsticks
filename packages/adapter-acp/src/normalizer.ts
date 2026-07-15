/**
 * ACP `session/update` → normalized AgentEvent translation (M6 / A2).
 *
 * The ACP adapter observes through the Agent Client Protocol's structured
 * JSON-RPC surface — the same shape as the Codex app-server adapter, so this
 * normalizer is the sibling of `adapter-codex/src/normalizer.ts`. Where the
 * Codex normalizer maps `ServerNotification`s, this one maps ACP
 * `SessionNotification`s (`{ sessionId, update }`) whose `update` is a
 * discriminated `SessionUpdate` (agentclientprotocol.com/protocol/prompt-turn).
 *
 * ONE structural difference from Codex drives the split of responsibility with
 * the driver: in ACP the TURN BOUNDARY is the `session/prompt` request itself —
 * it resolves with a `stopReason` — NOT a notification. So `turn.started` /
 * `turn.completed` are synthesized by the driver around that request (A3); this
 * normalizer only translates the streamed `session/update`s that occur DURING a
 * turn. It never emits turn events.
 *
 * Mapping (grounded in the ACP schema and integration coverage):
 * - `agent_message_chunk`  → assistant.message, deltas accumulated by messageId
 *                            (`final:false`; the driver seals lastAssistantMessage
 *                            on turn.completed since ACP has no per-message final).
 * - `user_message_chunk`   → dropped: it's the echo of the prompt the driver just
 *                            sent, already carried by the synthesized turn.started.
 * - `agent_thought_chunk`  → presence-only reasoning.started/progress; its raw
 *                            content remains on the envelope, never the core event.
 * - `tool_call`            → tool.started (+ terminal event if it arrives already
 *                            completed/failed).
 * - `tool_call_update`     → tool.completed / tool.failed on terminal status;
 *                            intermediate pending/in_progress updates are covered
 *                            by tool.started and dropped.
 * - everything else (plan*, *_update, usage) → adapter.native-event (ADR-008:
 *                            session-relevant but unmodeled is retained, never
 *                            silently lost).
 *
 * Stateful by necessity (delta accumulation) — one normalizer instance per ACP
 * session.
 */

import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibecook/chopsticks-core';
import type { ContentBlock, SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';

export interface NormalizedUpdate {
  events: AgentEvent[];
}

/** Text of a single ACP content block (only `text` blocks carry prose). */
function contentText(content: ContentBlock | undefined): string {
  if (content && content.type === 'text') return content.text ?? '';
  return '';
}

function detailOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  } catch {
    return undefined;
  }
}

function toolPresentation(kind: string | undefined, title: string | undefined, input: unknown): ToolPresentation {
  const normalized = (kind ?? title ?? '').toLowerCase();
  let activity: ToolActivityKind = 'other';
  let fallback = 'Using tool';
  if (normalized === 'execute') {
    activity = 'command';
    fallback = 'Running command';
  } else if (normalized === 'read') {
    activity = 'file-read';
    fallback = 'Reading files';
  } else if (['edit', 'delete', 'move'].includes(normalized)) {
    activity = 'file-edit';
    fallback = 'Editing files';
  } else if (['fetch', 'search'].includes(normalized)) {
    activity = 'web-search';
    fallback = normalized === 'search' ? 'Searching the web' : 'Fetching from the web';
  }
  return { kind: activity, title: title || fallback, detail: detailOf(input) };
}

export class AcpNotificationNormalizer {
  /** Accumulated assistant text keyed by ACP messageId (deltas are additive). */
  private messageBuffers = new Map<string, string>();
  private reasoningActive = false;

  normalize(notif: SessionNotification): NormalizedUpdate {
    const update = notif.update;
    const events: AgentEvent[] = [];
    const kind = update.sessionUpdate;

    switch (kind) {
      case 'agent_message_chunk': {
        const messageId = update.messageId ?? 'acp-msg';
        const acc = (this.messageBuffers.get(messageId) ?? '') + contentText(update.content);
        this.messageBuffers.set(messageId, acc);
        events.push({
          type: 'assistant.message',
          messageId,
          text: acc,
          final: false,
          displayOnly: false,
        });
        break;
      }

      case 'user_message_chunk':
        // The prompt echo — the driver already emitted turn.started carrying this
        // text. Dropping it avoids a duplicate user-prompt event.
        break;

      case 'agent_thought_chunk':
        events.push({
          type: this.reasoningActive ? 'reasoning.progress' : 'reasoning.started',
          reasoningId: update.messageId ?? undefined,
        });
        this.reasoningActive = true;
        break;

      case 'tool_call': {
        const toolCallId = update.toolCallId;
        const tool = update.kind ?? update.title ?? 'tool';
        const presentation = toolPresentation(update.kind ?? undefined, update.title ?? undefined, update.rawInput);
        events.push({ type: 'tool.started', toolCallId, tool, input: update.rawInput, presentation });
        // A tool_call may arrive already resolved (fast/synchronous tools).
        if (update.status === 'completed') {
          events.push({
            type: 'tool.completed',
            toolCallId,
            tool,
            output: update.rawOutput ?? update.content,
            presentation,
          });
        } else if (update.status === 'failed') {
          events.push({ type: 'tool.failed', toolCallId, tool });
        }
        break;
      }

      case 'tool_call_update': {
        const toolCallId = update.toolCallId;
        const tool = update.kind ?? update.title ?? undefined;
        const presentation = toolPresentation(update.kind ?? undefined, update.title ?? undefined, update.rawInput);
        if (update.status === 'completed') {
          events.push({
            type: 'tool.completed',
            toolCallId,
            tool,
            output: update.rawOutput ?? update.content,
            presentation,
          });
        } else if (update.status === 'failed') {
          events.push({ type: 'tool.failed', toolCallId, tool, presentation });
        }
        // pending / in_progress: covered by the tool.started from `tool_call`.
        break;
      }

      default:
        // plan / plan_update / plan_removed / available_commands_update /
        // current_mode_update / config_option_update / session_info_update /
        // usage_update / any future kind — retained, semantics not invented.
        events.push({ type: 'adapter.native-event', adapter: 'acp', nativeType: kind });
        break;
    }

    return { events };
  }

  /** The full accumulated text for a message id (driver seals it on turn end). */
  assistantText(messageId?: string): string {
    if (messageId) return this.messageBuffers.get(messageId) ?? '';
    // No id given: return the most recently updated buffer (single-message turns).
    let last = '';
    for (const v of this.messageBuffers.values()) last = v;
    return last;
  }

  completeReasoning(): void {
    this.reasoningActive = false;
  }
}
