/**
 * Claude Code hook-event registry — DATA, not code (DESIGN §16.5: settings
 * are generated from a registry, never handwritten; §10: capability-probe,
 * don't assume).
 *
 * Ground truth: the Phase 0 headless census and the M1 interactive census
 * (draft/HOOK-SURFACE-FINDINGS.md), captured against Claude Code 2.1.207.
 * Every 'verified-*' event has a representative payload fixture in
 * @vibecook/chopsticks-testing (fixtures/hooks/<Event>.jsonl).
 *
 * Transport preference implements the hybrid bridge (DESIGN §16.4):
 * high-frequency events go over HTTP (no forwarder process per event);
 * low-frequency lifecycle events tolerate the command forwarder, which is
 * also the fallback if a probe finds an event type without HTTP support.
 */

export type HookTransport = 'http' | 'command';

export type HookConfidence =
  | 'verified-headless' // fired in `-p` runs A–F
  | 'verified-interactive' // fired only under the M1 PTY census
  | 'unverified'; // name known (spaghetti HookEventName union); never observed

export interface HookEventSpec {
  /** Claude Code `hook_event_name`. */
  event: string;
  transport: HookTransport;
  confidence: HookConfidence;
  /** Hook timeout written into generated settings. */
  timeoutSec: number;
  /** Payload fields beyond the common envelope that the normalizer relies on. */
  notes?: string;
}

export const CLAUDE_HOOK_REGISTRY: readonly HookEventSpec[] = [
  // ─── lifecycle (low frequency → command transport tolerated) ─────────────
  {
    event: 'SessionStart',
    transport: 'command',
    confidence: 'verified-headless',
    timeoutSec: 5,
    notes: 'source, session_title',
  },
  { event: 'SessionEnd', transport: 'command', confidence: 'verified-headless', timeoutSec: 5, notes: 'reason' },
  {
    event: 'InstructionsLoaded',
    transport: 'command',
    confidence: 'verified-headless',
    timeoutSec: 5,
    notes: 'file_path, memory_type, load_reason',
  },

  // ─── turn + display (high frequency → http) ──────────────────────────────
  {
    event: 'UserPromptSubmit',
    transport: 'http',
    confidence: 'verified-headless',
    timeoutSec: 5,
    notes: 'prompt (verbatim — injection confirmation), prompt_id',
  },
  {
    event: 'MessageDisplay',
    transport: 'http',
    confidence: 'verified-headless',
    timeoutSec: 2,
    notes: 'STREAMING: delta, index, final, turn_id, message_id',
  },
  {
    event: 'Stop',
    transport: 'http',
    confidence: 'verified-headless',
    timeoutSec: 5,
    notes: 'last_assistant_message, stop_hook_active',
  },
  { event: 'StopFailure', transport: 'http', confidence: 'unverified', timeoutSec: 5 },

  // ─── tools + permissions (high frequency → http) ─────────────────────────
  {
    event: 'PreToolUse',
    transport: 'http',
    confidence: 'verified-headless',
    timeoutSec: 5,
    notes: 'tool_name, tool_input, tool_use_id',
  },
  {
    event: 'PostToolUse',
    transport: 'http',
    confidence: 'verified-headless',
    timeoutSec: 5,
    notes: '+ tool_response, duration_ms',
  },
  {
    event: 'PostToolUseFailure',
    transport: 'http',
    confidence: 'verified-interactive',
    timeoutSec: 5,
    notes: 'error, is_interrupt; fires only for APPROVED tools that fail',
  },
  {
    event: 'PermissionRequest',
    transport: 'http',
    confidence: 'verified-interactive',
    timeoutSec: 5,
    notes:
      'NO tool_use_id/request id — correlate prompt_id+tool_name (FIFO); permission_suggestions[]; fires at dialog-show',
  },

  // ─── subagents + tasks ────────────────────────────────────────────────────
  {
    event: 'SubagentStart',
    transport: 'http',
    confidence: 'verified-interactive',
    timeoutSec: 5,
    notes: 'agent_id (17-hex), agent_type',
  },
  {
    event: 'SubagentStop',
    transport: 'http',
    confidence: 'verified-interactive',
    timeoutSec: 5,
    notes: 'RE-ENTRANT: 1× stop_hook_active:false then N× true; agent_transcript_path',
  },
  {
    event: 'TaskCreated',
    transport: 'command',
    confidence: 'unverified',
    timeoutSec: 5,
    notes: 'NOT fired by Task-tool subagents',
  },
  { event: 'TaskCompleted', transport: 'command', confidence: 'unverified', timeoutSec: 5 },

  // ─── system / config / other (low frequency) ─────────────────────────────
  {
    event: 'Notification',
    transport: 'http',
    confidence: 'verified-interactive',
    timeoutSec: 5,
    notes: 'message, notification_type ("permission_prompt" observed)',
  },
  { event: 'PreCompact', transport: 'command', confidence: 'unverified', timeoutSec: 10 },
  { event: 'PostCompact', transport: 'command', confidence: 'unverified', timeoutSec: 10 },
  { event: 'ConfigChange', transport: 'command', confidence: 'unverified', timeoutSec: 5 },
  { event: 'CwdChanged', transport: 'command', confidence: 'unverified', timeoutSec: 5 },
  { event: 'FileChanged', transport: 'command', confidence: 'unverified', timeoutSec: 5 },
  { event: 'TeammateIdle', transport: 'command', confidence: 'unverified', timeoutSec: 5 },
  { event: 'WorktreeCreate', transport: 'command', confidence: 'unverified', timeoutSec: 10 },
  { event: 'WorktreeRemove', transport: 'command', confidence: 'unverified', timeoutSec: 10 },
  { event: 'Elicitation', transport: 'command', confidence: 'unverified', timeoutSec: 5 },
  { event: 'ElicitationResult', transport: 'command', confidence: 'unverified', timeoutSec: 5 },
];

export function getHookSpec(event: string): HookEventSpec | undefined {
  return CLAUDE_HOOK_REGISTRY.find((s) => s.event === event);
}

/** Events safe to wire by default: observed at least once on a real session. */
export function verifiedHookEvents(): HookEventSpec[] {
  return CLAUDE_HOOK_REGISTRY.filter((s) => s.confidence !== 'unverified');
}
