/**
 * Claude hook → normalized AgentEvent translation (DESIGN §16.7), corrected
 * by the two censuses (draft/HOOK-SURFACE-FINDINGS.md):
 *
 * - `prompt_id` is the native turn id; MessageDisplay additionally carries a
 *   distinct `turn_id` (assistant response cycle) — both are surfaced for
 *   envelope stamping.
 * - MessageDisplay STREAMS: deltas are accumulated per message_id and an
 *   assistant.message is emitted per delta with `final` marking completion.
 * - PermissionRequest carries NO tool_use_id or request id (it fires at
 *   dialog-show, before the call gets an id). A request id is synthesized and
 *   correlated FIFO by (session, prompt_id, tool_name); a matching PreToolUse
 *   arriving later means the permission was ALLOWED. Denial produces nothing
 *   (the Pre-without-Post absence pattern) — timing that out is the session
 *   tracker's job, not this normalizer's.
 * - SubagentStop is re-entrant (1× stop_hook_active:false, then N× true):
 *   only the first occurrence per agent_id normalizes to subagent.stopped.
 * - Unknown events are RETAINED (ADR-008) as adapter.native-event; the raw
 *   body always rides the envelope's nativeEvent upstream.
 *
 * Stateful by necessity (delta accumulation, permission FIFO, stop dedup) —
 * one normalizer instance per Claude session.
 */

import type { AgentEvent } from '@vibecook/chopsticks-core';

export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt_id?: string;
  [key: string]: unknown;
}

export interface NormalizedHook {
  events: AgentEvent[];
  sessionId?: string;
  transcriptPath?: string;
  /** User-turn correlation (`prompt_id`). */
  promptId?: string;
  /** Assistant response-cycle correlation (MessageDisplay `turn_id`). */
  turnId?: string;
}

interface PendingPermission {
  requestId: string;
  promptId: string;
  toolName: string;
}

const MAX_ACCUMULATORS = 64;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export class ClaudeHookNormalizer {
  private messageBuffers = new Map<string, string>();
  private pendingPermissions: PendingPermission[] = [];
  private stoppedSubagents = new Set<string>();
  private permissionCounter = 0;

  normalize(body: ClaudeHookPayload): NormalizedHook {
    const name = str(body.hook_event_name) ?? 'unknown';
    const promptId = str(body.prompt_id);
    const result: NormalizedHook = {
      events: [],
      sessionId: str(body.session_id),
      transcriptPath: str(body.transcript_path),
      promptId,
    };

    switch (name) {
      case 'SessionStart':
        result.events.push({
          type: 'session.started',
          nativeSessionId: result.sessionId,
          title: str(body.session_title),
          startSource: str(body.source),
        });
        break;

      case 'InstructionsLoaded':
        // load_reason "session_start" is the closest thing to a boot-finished
        // signal; other loads (e.g. /memory edits) stay native-only.
        if (str(body.load_reason) === 'session_start') {
          result.events.push({ type: 'session.ready' });
        } else {
          result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        }
        break;

      case 'UserPromptSubmit':
        result.events.push({ type: 'turn.started', turnId: promptId, prompt: str(body.prompt) });
        break;

      case 'MessageDisplay': {
        const messageId = str(body.message_id) ?? 'unknown-message';
        const final = body.final === true;
        const text = (this.messageBuffers.get(messageId) ?? '') + (str(body.delta) ?? '');
        if (final) {
          this.messageBuffers.delete(messageId);
        } else {
          if (!this.messageBuffers.has(messageId) && this.messageBuffers.size >= MAX_ACCUMULATORS) {
            const oldest = this.messageBuffers.keys().next().value;
            if (oldest !== undefined) this.messageBuffers.delete(oldest);
          }
          this.messageBuffers.set(messageId, text);
        }
        result.turnId = str(body.turn_id);
        result.events.push({
          type: 'assistant.message',
          messageId,
          turnId: result.turnId,
          text,
          final,
          displayOnly: true,
        });
        break;
      }

      case 'PermissionRequest': {
        this.permissionCounter += 1;
        const toolName = str(body.tool_name) ?? 'unknown-tool';
        const requestId = `perm-${promptId ?? 'unknown'}-${toolName}-${this.permissionCounter}`;
        if (promptId) this.pendingPermissions.push({ requestId, promptId, toolName });
        result.events.push({
          type: 'permission.requested',
          requestId,
          tool: toolName,
          input: body.tool_input,
          presentation: 'native-tui',
        });
        break;
      }

      case 'PreToolUse': {
        // An executing tool that matches a pending permission means the user
        // (or a rule) ALLOWED it — the only affirmative resolution signal.
        const toolName = str(body.tool_name) ?? 'unknown-tool';
        const matchIndex = this.pendingPermissions.findIndex((p) => p.promptId === promptId && p.toolName === toolName);
        if (matchIndex !== -1) {
          const [pending] = this.pendingPermissions.splice(matchIndex, 1);
          result.events.push({ type: 'permission.resolved', requestId: pending.requestId, outcome: 'allowed' });
        }
        result.events.push({
          type: 'tool.requested',
          toolCallId: str(body.tool_use_id) ?? `tool-${promptId ?? 'unknown'}-${toolName}`,
          tool: toolName,
          input: body.tool_input,
        });
        break;
      }

      case 'PostToolUse':
        result.events.push({
          type: 'tool.completed',
          toolCallId: str(body.tool_use_id) ?? 'unknown-tool-call',
          tool: str(body.tool_name),
          output: body.tool_response,
          durationMs: num(body.duration_ms),
        });
        break;

      case 'PostToolUseFailure':
        result.events.push({
          type: 'tool.failed',
          toolCallId: str(body.tool_use_id) ?? 'unknown-tool-call',
          tool: str(body.tool_name),
          error: str(body.error),
        });
        break;

      case 'Stop':
        result.events.push({
          type: 'turn.completed',
          turnId: promptId,
          lastAssistantMessage: str(body.last_assistant_message),
        });
        break;

      case 'StopFailure':
        result.events.push({ type: 'turn.failed', turnId: promptId, error: str(body.error_type) ?? str(body.error) });
        break;

      case 'SessionEnd':
        result.events.push({ type: 'session.exited', reason: str(body.reason) });
        break;

      case 'SubagentStart':
        result.events.push({
          type: 'subagent.started',
          subagentId: str(body.agent_id) ?? 'unknown-agent',
          agentType: str(body.agent_type),
        });
        break;

      case 'SubagentStop': {
        const agentId = str(body.agent_id) ?? 'unknown-agent';
        // Re-entrant stop-hook guard: only the first Stop per agent is real.
        if (this.stoppedSubagents.has(agentId)) {
          result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        } else {
          this.stoppedSubagents.add(agentId);
          result.events.push({ type: 'subagent.stopped', subagentId: agentId });
        }
        break;
      }

      case 'TaskCreated':
        result.events.push({
          type: 'task.created',
          taskId: str(body.task_id) ?? `task-${promptId ?? 'unknown'}`,
          description: str(body.description),
        });
        break;

      case 'TaskCompleted':
        result.events.push({ type: 'task.completed', taskId: str(body.task_id) ?? 'unknown-task' });
        break;

      case 'Notification':
        result.events.push({
          type: 'notification',
          message: str(body.message),
          notificationType: str(body.notification_type),
        });
        break;

      default:
        result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        break;
    }

    return result;
  }

  /** Pending (unresolved) permission requests — the deny-timeout input. */
  pendingPermissionRequests(): readonly PendingPermission[] {
    return this.pendingPermissions;
  }
}
