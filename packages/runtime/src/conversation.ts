import type { AgentEventEnvelope, ToolActivityKind, ToolPresentation } from '@vibecook/chopsticks-core';

export interface ConversationUserMessage {
  id: string;
  kind: 'user';
  turnId?: string;
  text: string;
}

export interface ConversationAssistantMessage {
  id: string;
  kind: 'assistant';
  turnId?: string;
  markdown: string;
  streaming: boolean;
}

export type ConversationActivityKind = 'reasoning' | ToolActivityKind | 'permission' | 'subagent' | 'task';

export interface ConversationActivity {
  id: string;
  kind: 'activity';
  turnId?: string;
  activity: ConversationActivityKind;
  status: 'requested' | 'running' | 'completed' | 'failed';
  title: string;
  detail?: string;
  /** Only protocol-designated, user-displayable reasoning summaries land here. */
  summary?: string;
  confidence: AgentEventEnvelope['confidence'];
}

export interface ConversationNotice {
  id: string;
  kind: 'notice';
  text: string;
  tone: 'neutral' | 'error';
}

export type ConversationItem =
  ConversationUserMessage | ConversationAssistantMessage | ConversationActivity | ConversationNotice;

export interface AgentConversationSnapshot {
  items: ConversationItem[];
  /** True when at least one assistant message is still receiving deltas. */
  responding: boolean;
}

function turnKey(envelope: AgentEventEnvelope, eventTurnId?: string): string | undefined {
  return envelope.promptId ?? envelope.turnId ?? eventTurnId;
}

function fallbackPresentation(tool: string | undefined): ToolPresentation {
  const name = tool || 'tool';
  return { kind: 'other', title: `Using ${name}` };
}

/** Incremental, provider-neutral projection from normalized events to UI items. */
export class AgentConversationProjector {
  private readonly items: ConversationItem[] = [];
  private readonly assistantByMessage = new Map<string, ConversationAssistantMessage>();
  private readonly activities = new Map<string, ConversationActivity>();
  private readonly lastAssistantByTurn = new Map<string, ConversationAssistantMessage>();

  consume(envelope: AgentEventEnvelope): void {
    const event = envelope.event;
    const correlatedTurn = turnKey(envelope, 'turnId' in event ? event.turnId : undefined);

    switch (event.type) {
      case 'turn.started':
        if (event.prompt?.trim()) {
          this.items.push({
            id: `user:${correlatedTurn ?? envelope.sequence}`,
            kind: 'user',
            turnId: correlatedTurn,
            text: event.prompt,
          });
        }
        break;

      case 'assistant.message': {
        const messageKey = `${correlatedTurn ?? 'none'}:${event.messageId ?? 'current'}`;
        let item = this.assistantByMessage.get(messageKey);
        if (!item && !event.messageId && correlatedTurn) item = this.lastAssistantByTurn.get(correlatedTurn);
        if (!item) {
          item = {
            id: `assistant:${messageKey}:${envelope.sequence}`,
            kind: 'assistant',
            turnId: correlatedTurn,
            markdown: '',
            streaming: true,
          };
          this.items.push(item);
          this.assistantByMessage.set(messageKey, item);
        }
        item.markdown = event.text;
        item.streaming = event.final === false;
        if (correlatedTurn) this.lastAssistantByTurn.set(correlatedTurn, item);
        break;
      }

      case 'reasoning.started':
      case 'reasoning.progress':
      case 'reasoning.summary': {
        const key = `reasoning:${event.reasoningId ?? correlatedTurn ?? 'current'}`;
        const activity = this.activity(key, correlatedTurn, {
          activity: 'reasoning',
          status: 'running',
          title: 'Thinking',
          confidence: envelope.confidence,
        });
        activity.status = 'running';
        activity.confidence = envelope.confidence;
        if (event.type === 'reasoning.summary') activity.summary = event.text;
        break;
      }

      case 'reasoning.completed': {
        const key = `reasoning:${event.reasoningId ?? correlatedTurn ?? 'current'}`;
        const activity = this.activities.get(key);
        if (activity) {
          activity.status = 'completed';
          activity.title = activity.summary ? 'Reasoned' : 'Thought through the request';
        }
        break;
      }

      case 'tool.requested':
      case 'tool.started': {
        const key = `tool:${event.toolCallId}`;
        const shown = event.presentation ?? fallbackPresentation(event.tool);
        const activity = this.activity(key, correlatedTurn, {
          activity: shown.kind,
          status: event.type === 'tool.requested' ? 'requested' : 'running',
          title: shown.title,
          detail: shown.detail,
          confidence: envelope.confidence,
        });
        activity.status = event.type === 'tool.requested' ? 'requested' : 'running';
        activity.title = shown.title;
        activity.detail = shown.detail ?? activity.detail;
        activity.activity = shown.kind;
        break;
      }

      case 'tool.completed':
      case 'tool.failed': {
        const key = `tool:${event.toolCallId}`;
        const shown = event.presentation ?? fallbackPresentation(event.tool);
        const existing = this.activities.get(key);
        const activity = this.activity(key, correlatedTurn, {
          activity: shown.kind,
          status: event.type === 'tool.failed' ? 'failed' : 'completed',
          title: shown.title,
          detail: shown.detail,
          confidence: envelope.confidence,
        });
        activity.status = event.type === 'tool.failed' ? 'failed' : 'completed';
        if (event.presentation || !existing) activity.title = shown.title;
        activity.detail = shown.detail ?? activity.detail;
        if (shown.kind !== 'other' || activity.activity === 'other') activity.activity = shown.kind;
        break;
      }

      case 'permission.requested':
        this.activity(`permission:${event.requestId}`, correlatedTurn, {
          activity: 'permission',
          status: 'requested',
          title: `Waiting for permission${event.tool ? ` · ${event.tool}` : ''}`,
          confidence: envelope.confidence,
        });
        break;

      case 'permission.resolved': {
        const activity = this.activities.get(`permission:${event.requestId}`);
        if (activity) {
          activity.status = event.outcome === 'allowed' ? 'completed' : 'failed';
          activity.title = event.outcome === 'allowed' ? 'Permission granted' : 'Permission denied';
        }
        break;
      }

      case 'subagent.started':
        this.activity(`subagent:${event.subagentId}`, correlatedTurn, {
          activity: 'subagent',
          status: 'running',
          title: event.agentType ? `Delegating to ${event.agentType}` : 'Delegating work',
          confidence: envelope.confidence,
        });
        break;

      case 'subagent.stopped': {
        const activity = this.activities.get(`subagent:${event.subagentId}`);
        if (activity) {
          activity.status = 'completed';
          activity.title = 'Delegated work completed';
        }
        break;
      }

      case 'task.created':
        this.activity(`task:${event.taskId}`, correlatedTurn, {
          activity: 'task',
          status: 'running',
          title: event.description || 'Working on task',
          confidence: envelope.confidence,
        });
        break;

      case 'task.completed': {
        const activity = this.activities.get(`task:${event.taskId}`);
        if (activity) activity.status = 'completed';
        break;
      }

      case 'turn.completed':
        this.sealTurn(correlatedTurn);
        break;

      case 'turn.failed':
        this.sealTurn(correlatedTurn);
        this.items.push({
          id: `notice:${envelope.sequence}`,
          kind: 'notice',
          text: `Turn failed${event.error ? `: ${event.error}` : ''}`,
          tone: 'error',
        });
        break;

      case 'notification':
        if (event.message) {
          this.items.push({
            id: `notice:${envelope.sequence}`,
            kind: 'notice',
            text: event.message,
            tone: event.notificationType === 'error' ? 'error' : 'neutral',
          });
        }
        break;

      default:
        break;
    }
  }

  snapshot(): AgentConversationSnapshot {
    const items = this.items.map((item) => ({ ...item }));
    return {
      items,
      responding: items.some((item) => item.kind === 'assistant' && item.streaming),
    };
  }

  private activity(
    id: string,
    turnId: string | undefined,
    initial: Omit<ConversationActivity, 'id' | 'kind' | 'turnId'>,
  ): ConversationActivity {
    let activity = this.activities.get(id);
    if (!activity) {
      activity = { id, kind: 'activity', turnId, ...initial };
      this.activities.set(id, activity);
      this.items.push(activity);
    }
    return activity;
  }

  private sealTurn(turnId: string | undefined): void {
    for (const item of this.items) {
      if (item.kind === 'notice') continue;
      if (item.turnId !== turnId) continue;
      if (item.kind === 'assistant') item.streaming = false;
      if (item.kind === 'activity' && item.activity === 'reasoning' && item.status === 'running') {
        item.status = 'completed';
      }
    }
  }
}
