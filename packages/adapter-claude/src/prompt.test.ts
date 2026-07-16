import { describe, expect, it } from 'vitest';
import { createPromptInjector, type PromptReceipt } from './prompt.js';
import type { TerminalAutomationOperation } from '@vibecook/chopsticks-core';

function harness(defaults?: { defaultConfirmationTimeoutMs?: number; accepted?: boolean }) {
  const operations: TerminalAutomationOperation[] = [];
  const injector = createPromptInjector({
    automate: async (operation) => {
      operations.push(operation);
      return defaults?.accepted === false ? { accepted: false, reason: 'human-input-conflict' } : { accepted: true };
    },
    defaultConfirmationTimeoutMs: defaults?.defaultConfirmationTimeoutMs,
  });
  return { operations, injector };
}

describe('createPromptInjector', () => {
  it('submits one atomic semantic paste-and-submit operation', async () => {
    const { operations, injector } = harness();
    const receiptPromise = injector.submit({ text: 'run the tests' });
    expect(operations).toEqual([{ kind: 'paste', text: 'run the tests', submit: true }]);

    injector.handleTurnStarted('prompt-1', 'run the tests');
    expect(await receiptPromise).toEqual({ status: 'confirmed', turnId: 'prompt-1' });
  });

  it('does NOT misattribute someone else’s turn: mismatched prompts keep waiting', async () => {
    const { injector } = harness({ defaultConfirmationTimeoutMs: 60 });
    const receiptPromise = injector.submit({ text: 'my injected prompt' });

    injector.handleTurnStarted('prompt-user', 'something the human typed');
    // Still active — the mismatch was ignored rather than claimed.
    expect(injector.isActive()).toBe(true);

    const receipt = await receiptPromise;
    expect(receipt.status).toBe('uncertain'); // timed out honestly
  });

  it('normalizes line endings for matching but preserves inner newlines', async () => {
    const { operations, injector } = harness();
    const receiptPromise = injector.submit({ text: 'line one\r\nline two\n' });
    expect(operations[0]).toEqual({ kind: 'paste', text: 'line one\nline two', submit: true });

    injector.handleTurnStarted('p', 'line one\nline two');
    expect((await receiptPromise).status).toBe('confirmed');
  });

  it('rejects concurrent injections instead of interleaving', async () => {
    const { injector } = harness({ defaultConfirmationTimeoutMs: 60 });
    const first = injector.submit({ text: 'first' });
    const second = await injector.submit({ text: 'second' });
    expect(second).toEqual({ status: 'rejected', reason: 'another injection is active' });
    injector.handleTurnStarted('t1', 'first');
    expect((await first).status).toBe('confirmed');
  });

  it('rejects while a native permission dialog is pending', async () => {
    const { operations, injector } = harness();
    injector.setPermissionPending(true);
    expect((await injector.submit({ text: 'blocked' })).status).toBe('rejected');
    expect(operations).toHaveLength(0);

    injector.setPermissionPending(false);
    const receipt = injector.submit({ text: 'now ok' });
    injector.handleTurnStarted('t', 'now ok');
    expect((await receipt).status).toBe('confirmed');
  });

  it('rejects when accepted human input won the daemon ordering race', async () => {
    const { injector } = harness({ accepted: false });
    const receipt = await injector.submit({ text: 'automation prompt' });
    expect(receipt).toEqual({ status: 'rejected', reason: 'human-input-conflict' });
    expect(injector.isActive()).toBe(false);
  });

  it('paste-only stages without Enter and confirms immediately', async () => {
    const { operations, injector } = harness();
    const receipt = await injector.submit({ text: 'staged', mode: 'paste-only' });
    expect(receipt.status).toBe('confirmed');
    expect(operations).toEqual([{ kind: 'paste', text: 'staged', submit: false }]);
  });

  it('rejects empty prompts before touching the terminal', async () => {
    const { operations, injector } = harness();
    expect((await injector.submit({ text: '\n' })).status).toBe('rejected');
    expect(operations).toHaveLength(0);
  });

  it('times out as uncertain, never as a false confirmation', async () => {
    const { injector } = harness();
    const receipt: PromptReceipt = await injector.submit({ text: 'lost', confirmationTimeoutMs: 40 });
    expect(receipt.status).toBe('uncertain');
    expect((receipt as { reason: string }).reason).toContain('no matching UserPromptSubmit');
  });
});
