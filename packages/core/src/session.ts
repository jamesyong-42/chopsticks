/**
 * The agent-agnostic session contract (DESIGN §9), lifted into core once a
 * second driver existed to test it against (M5: Claude's hook+PTY driver and
 * Codex's structured app-server driver). Before that, `AgentSession` lived as a
 * concrete `ClaudeSession` in the Claude adapter — lifting off one example
 * would have baked in Claude's shape.
 *
 * Zero I/O by design (like the rest of core): interfaces only. Concrete drivers
 * (`createClaudeSession`, the forthcoming `createCodexSession`) implement these.
 */

import type { AgentEventEnvelope, ObservationLevel } from './events.js';
import type { SessionRuntimeState } from './state.js';

/**
 * A programmatic prompt submission (generalized from the Claude guarded
 * injector, DESIGN §17).
 */
export interface PromptSubmission {
  text: string;
  /**
   * Paste-and-submit (default) appends Enter; paste-only leaves it staged.
   * Meaningful only to guarded-paste (native-TUI) injectors; structured drivers
   * submit atomically and ignore it.
   */
  mode?: 'paste-and-submit' | 'paste-only';
  confirmationTimeoutMs?: number;
}

/**
 * Outcome of a prompt submission. `uncertain` is first-class: a guarded-paste
 * injector cannot always prove the agent accepted exactly our text (DESIGN
 * §17). Structured drivers with deterministic confirmation never emit it.
 */
export type PromptReceipt =
  | { status: 'confirmed'; turnId?: string }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string };

/**
 * The handle every driver returns for one live agent process/thread — observed
 * and controlled. Process lifecycle (spawn/terminate) belongs to the host, not
 * this handle (ADR-007); `dispose()` tears down observation/control only. For
 * an adopted process inside a longer-lived shell PTY, the caller reports the
 * vendor process exit separately while keeping the terminal alive.
 *
 * Adapters MAY extend this with native extras, but applications should normally
 * consume the provider-neutral AgentRuntime surface from chopsticks-runtime.
 */
export interface AgentSession {
  /** Native/join id — the chopsticks ↔ spaghetti correlation key. */
  readonly sessionId: string;
  /** The host's id for the terminal session (attach/write/kill routing). */
  readonly runtimeSessionId: string;
  state(): SessionRuntimeState;
  /** Honest, current observation level — never overstated (DESIGN §19.2). */
  observationLevel(): ObservationLevel;
  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
  submitPrompt(submission: PromptSubmission): Promise<PromptReceipt>;
  /** Tear down observation/control. Process lifecycle stays with the host. */
  dispose(): Promise<void>;
}
