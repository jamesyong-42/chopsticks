/**
 * Normalized agent events and the envelope that carries them (DESIGN §14),
 * corrected by the Phase 0 probe (draft/HOOK-SURFACE-FINDINGS.md):
 * - Claude Code supplies BOTH a prompt id (user turn, on all post-prompt hook
 *   events) and a distinct assistant turn id (MessageDisplay) — the envelope
 *   keeps both instead of collapsing them.
 * - MessageDisplay streams deltas keyed by message id; assistant.message here
 *   is the accumulated form, `final` marks completion.
 * - Stop carries the final assistant text, surfaced on turn.completed.
 */

/** DESIGN ADR-001 — native-tui is a first-class mode, not a fallback. */
export type AgentExecutionMode = 'native-tui' | 'structured' | 'acp';

/** DESIGN §19.2 — the runtime must never overstate what it can observe. */
export type ObservationLevel = 'native-hooks' | 'native-log' | 'workspace-process' | 'terminal-only';

/** DESIGN §14.1 — where a normalized event came from. */
export type AgentEventSource =
  'native-hook' | 'native-transcript' | 'workspace' | 'process' | 'terminal-inference' | 'runtime';

export type AgentEventConfidence = 'authoritative' | 'derived' | 'inferred';

/** DESIGN §21.4 — process exit and semantic turn completion are separate facts. */
export type ProcessExitReason =
  | 'completed'
  | 'user-terminated'
  | 'runtime-terminated'
  | 'signal'
  | 'crash'
  | 'spawn-failed'
  | 'workspace-failed'
  | 'unknown';

export interface AgentEventEnvelope<T extends AgentEvent = AgentEvent> {
  /** Monotonic per session, assigned by the runtime at ingestion, before fan-out. */
  sequence: number;
  sessionId: string;
  nativeSessionId?: string;
  /** User-turn correlation (Claude Code `prompt_id`). */
  promptId?: string;
  /** Assistant response-cycle correlation (Claude Code `turn_id`). */
  turnId?: string;
  timestamp: string;
  monotonicTime: number;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  event: T;
  /** DESIGN ADR-008 — the raw native event is always retained. */
  nativeEvent?: unknown;
}

// ---------------------------------------------------------------------------
// Event union (DESIGN §14.2)
// ---------------------------------------------------------------------------

export interface SessionStartedEvent {
  type: 'session.started';
  nativeSessionId?: string;
  title?: string;
  /** Claude Code `SessionStart.source`, e.g. "startup". */
  startSource?: string;
}

export interface SessionReadyEvent {
  type: 'session.ready';
}

export interface SessionExitedEvent {
  type: 'session.exited';
  /** Claude Code `SessionEnd.reason`; value set not yet fully mapped. */
  reason?: string;
}

export interface TurnStartedEvent {
  type: 'turn.started';
  /** Claude Code `prompt_id`. */
  turnId?: string;
  prompt?: string;
}

export interface TurnCompletedEvent {
  type: 'turn.completed';
  turnId?: string;
  stopReason?: string;
  /** Claude Code `Stop.last_assistant_message`. */
  lastAssistantMessage?: string;
}

export interface TurnFailedEvent {
  type: 'turn.failed';
  turnId?: string;
  error?: string;
}

export interface AssistantMessageEvent {
  type: 'assistant.message';
  messageId?: string;
  turnId?: string;
  text: string;
  /** False while deltas are still accumulating (MessageDisplay `final`). */
  final?: boolean;
  /** True when sourced from display events rather than the transcript. */
  displayOnly?: boolean;
}

export interface ToolRequestedEvent {
  type: 'tool.requested';
  toolCallId: string;
  tool: string;
  input?: unknown;
}

/** For structured/ACP drivers that distinguish acceptance from execution. */
export interface ToolStartedEvent {
  type: 'tool.started';
  toolCallId: string;
  tool?: string;
}

export interface ToolCompletedEvent {
  type: 'tool.completed';
  toolCallId: string;
  tool?: string;
  output?: unknown;
  durationMs?: number;
}

export interface ToolFailedEvent {
  type: 'tool.failed';
  toolCallId: string;
  tool?: string;
  error?: string;
}

export interface PermissionRequestedEvent {
  type: 'permission.requested';
  requestId: string;
  toolCallId?: string;
  tool?: string;
  input?: unknown;
  presentation: 'native-tui' | 'host-ui';
}

export interface PermissionResolvedEvent {
  type: 'permission.resolved';
  requestId: string;
  outcome: 'allowed' | 'denied' | 'dismissed' | 'unknown';
}

export interface SubagentStartedEvent {
  type: 'subagent.started';
  subagentId: string;
  agentType?: string;
}

export interface SubagentStoppedEvent {
  type: 'subagent.stopped';
  subagentId: string;
}

export interface TaskCreatedEvent {
  type: 'task.created';
  taskId: string;
  description?: string;
}

export interface TaskCompletedEvent {
  type: 'task.completed';
  taskId: string;
}

export interface WorkspaceChangedEvent {
  type: 'workspace.changed';
  paths?: string[];
}

export interface ProcessStartedEvent {
  type: 'process.started';
  pid: number;
}

export interface ProcessExitedEvent {
  type: 'process.exited';
  exitCode?: number;
  signal?: string;
  reason: ProcessExitReason;
}

export interface NativeNotificationEvent {
  type: 'notification';
  message?: string;
  notificationType?: string;
}

/** DESIGN ADR-008 — unrecognized native events survive normalization. */
export interface UnknownNativeEvent {
  type: 'adapter.native-event';
  adapter: string;
  nativeType?: string;
}

export type AgentEvent =
  | SessionStartedEvent
  | SessionReadyEvent
  | SessionExitedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | AssistantMessageEvent
  | ToolRequestedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | SubagentStartedEvent
  | SubagentStoppedEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | WorkspaceChangedEvent
  | ProcessStartedEvent
  | ProcessExitedEvent
  | NativeNotificationEvent
  | UnknownNativeEvent;

// ---------------------------------------------------------------------------
// Envelope stamping
// ---------------------------------------------------------------------------

export interface EnvelopeStamper {
  next<T extends AgentEvent>(fields: Omit<AgentEventEnvelope<T>, 'sequence'>): AgentEventEnvelope<T>;
}

/**
 * Sequence numbers are assigned at ingestion, before fan-out, so every
 * consumer observes the same order (DESIGN §12.1 applies the same rule to
 * terminal chunks). One stamper per session.
 */
export function createEnvelopeStamper(): EnvelopeStamper {
  let sequence = 0;
  return {
    next(fields) {
      sequence += 1;
      return { sequence, ...fields };
    },
  };
}
