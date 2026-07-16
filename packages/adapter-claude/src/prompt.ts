/**
 * Guarded programmatic prompt submission (DESIGN §17).
 *
 * Injection is terminal automation, not a protocol request, so honesty about
 * outcomes is the core design: `uncertain` is a first-class receipt, and the
 * confirmation REQUIRES the native UserPromptSubmit whose `prompt` payload
 * exactly matches the injected text (verbatim per the Phase 0 census). An
 * unmatched wait would misattribute a human's concurrent submission as ours —
 * the race documented in DESIGN §17.2.
 *
 * Gates before any operation is accepted (§17.2 algorithm):
 * - no injection while another injection is active (queuePolicy 'queue' is
 *   deliberately unimplemented in v1 — callers get 'rejected' and retry)
 * - no injection while a native permission dialog is pending
 * - accepted human input has absolute priority; the terminal service rejects
 *   an automation operation whose expected human-input epoch is stale
 *
 * The injector never touches a PTY directly. It submits one semantic paste
 * operation so bracketed paste and Enter cannot interleave with human input.
 */

// Prompt submission/receipt types are the shared contract (DESIGN §17) — lifted
// to core in M5 C3. Re-exported here so this module and the barrel keep working.
import type {
  PromptSubmission,
  PromptReceipt,
  TerminalAutomationOperation,
  TerminalAutomationResult,
} from '@vibecook/chopsticks-core';
export type { PromptSubmission, PromptReceipt };

export interface PromptInjectorOptions {
  automate: (operation: TerminalAutomationOperation) => Promise<TerminalAutomationResult>;
  defaultConfirmationTimeoutMs?: number;
}

export interface PromptInjector {
  submit(submission: PromptSubmission): Promise<PromptReceipt>;
  /** Wire from normalized events: every turn.started for this session. */
  handleTurnStarted(turnId: string | undefined, prompt: string | undefined): void;
  /** Wire from permission.requested/resolved: blocks new injections while true. */
  setPermissionPending(pending: boolean): void;
  isActive(): boolean;
}

/** Claude receives what we paste verbatim; only line endings are normalized. */
function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

interface ActiveInjection {
  expectedPrompt: string;
  submitted: boolean; // paste-and-submit vs paste-only
  settle: (receipt: PromptReceipt) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createPromptInjector(options: PromptInjectorOptions): PromptInjector {
  let active: ActiveInjection | null = null;
  let permissionPending = false;

  function settle(receipt: PromptReceipt): void {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    const { settle: resolve } = active;
    active = null;
    resolve(receipt);
  }

  return {
    async submit(submission: PromptSubmission): Promise<PromptReceipt> {
      if (active) {
        return { status: 'rejected', reason: 'another injection is active' };
      }
      if (permissionPending) {
        return { status: 'rejected', reason: 'native permission dialog pending' };
      }
      const text = normalizeText(submission.text);
      if (text.length === 0) {
        return { status: 'rejected', reason: 'empty prompt' };
      }

      const submitted = submission.mode !== 'paste-only';
      const timeoutMs = submission.confirmationTimeoutMs ?? options.defaultConfirmationTimeoutMs ?? 5000;

      let resolveReceipt!: (receipt: PromptReceipt) => void;
      const receipt = new Promise<PromptReceipt>((resolve) => {
        resolveReceipt = resolve;
      });
      const injection: ActiveInjection = {
        expectedPrompt: text,
        submitted,
        settle: resolveReceipt,
        timer: undefined,
      };
      active = injection;
      try {
        const result = await options.automate({ kind: 'paste', text, submit: submitted });
        if (!result.accepted) {
          settle({ status: 'rejected', reason: result.reason });
        } else if (!submitted) {
          settle({ status: 'confirmed' });
        } else if (active === injection) {
          injection.timer = setTimeout(() => {
            settle({
              status: 'uncertain',
              reason: `no matching UserPromptSubmit within ${timeoutMs}ms (modal overlay, picker, or busy input?)`,
            });
          }, timeoutMs);
        }
      } catch (cause) {
        settle({ status: 'rejected', reason: cause instanceof Error ? cause.message : String(cause) });
      }
      return receipt;
    },

    handleTurnStarted(turnId, prompt): void {
      if (!active || !active.submitted) return;
      if (prompt !== undefined && normalizeText(prompt) === active.expectedPrompt) {
        settle({ status: 'confirmed', turnId });
      }
      // A non-matching turn.started is someone else's prompt: keep waiting —
      // timing out as uncertain beats claiming their turn as ours.
    },

    setPermissionPending(pending: boolean): void {
      permissionPending = pending;
    },

    isActive: () => active !== null,
  };
}
