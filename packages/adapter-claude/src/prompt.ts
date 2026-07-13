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
 * Gates before any bytes are written (§17.2 algorithm):
 * - no injection while another injection is active (queuePolicy 'queue' is
 *   deliberately unimplemented in v1 — callers get 'rejected' and retry)
 * - no injection while a native permission dialog is pending
 * - user input has absolute priority: notifyUserInput() during the wait
 *   resolves the receipt as 'uncertain' immediately (the paste bytes are
 *   already in Claude's editor; claiming 'rejected' would be a lie)
 *
 * The injector never touches a PTY directly — `write` is injected, so tests
 * and the driver wire it to whatever owns the terminal.
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface PromptSubmission {
  text: string;
  /** paste-and-submit (default) appends Enter; paste-only leaves it staged. */
  mode?: 'paste-and-submit' | 'paste-only';
  confirmationTimeoutMs?: number;
}

export type PromptReceipt =
  | { status: 'confirmed'; turnId?: string }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string };

export interface PromptInjectorOptions {
  write: (data: string) => void;
  defaultConfirmationTimeoutMs?: number;
}

export interface PromptInjector {
  submit(submission: PromptSubmission): Promise<PromptReceipt>;
  /** Wire from normalized events: every turn.started for this session. */
  handleTurnStarted(turnId: string | undefined, prompt: string | undefined): void;
  /** Wire from the terminal input path: any human keystroke. */
  notifyUserInput(): void;
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
  timer: ReturnType<typeof setTimeout>;
}

export function createPromptInjector(options: PromptInjectorOptions): PromptInjector {
  let active: ActiveInjection | null = null;
  let permissionPending = false;

  function settle(receipt: PromptReceipt): void {
    if (!active) return;
    clearTimeout(active.timer);
    const { settle: resolve } = active;
    active = null;
    resolve(receipt);
  }

  return {
    submit(submission: PromptSubmission): Promise<PromptReceipt> {
      if (active) {
        return Promise.resolve({ status: 'rejected', reason: 'another injection is active' });
      }
      if (permissionPending) {
        return Promise.resolve({ status: 'rejected', reason: 'native permission dialog pending' });
      }
      const text = normalizeText(submission.text);
      if (text.length === 0) {
        return Promise.resolve({ status: 'rejected', reason: 'empty prompt' });
      }

      const submitted = submission.mode !== 'paste-only';
      const timeoutMs = submission.confirmationTimeoutMs ?? options.defaultConfirmationTimeoutMs ?? 5000;

      return new Promise<PromptReceipt>((resolve) => {
        active = {
          expectedPrompt: text,
          submitted,
          settle: resolve,
          timer: setTimeout(() => {
            settle({
              status: 'uncertain',
              reason: `no matching UserPromptSubmit within ${timeoutMs}ms (modal overlay, picker, or busy input?)`,
            });
          }, timeoutMs),
        };

        options.write(PASTE_START + text + PASTE_END);
        if (submitted) {
          options.write('\r');
        } else {
          // Nothing to confirm for a staged paste — report success immediately.
          settle({ status: 'confirmed' });
        }
      });
    },

    handleTurnStarted(turnId, prompt): void {
      if (!active || !active.submitted) return;
      if (prompt !== undefined && normalizeText(prompt) === active.expectedPrompt) {
        settle({ status: 'confirmed', turnId });
      }
      // A non-matching turn.started is someone else's prompt: keep waiting —
      // timing out as uncertain beats claiming their turn as ours.
    },

    notifyUserInput(): void {
      if (!active) return;
      // The paste already reached the editor; the human now owns the input.
      settle({ status: 'uncertain', reason: 'user took control during confirmation' });
    },

    setPermissionPending(pending: boolean): void {
      permissionPending = pending;
    },

    isActive: () => active !== null,
  };
}
