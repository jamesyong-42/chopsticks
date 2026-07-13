import { describe, expect, it } from 'vitest';
import { createPromptInjector, type PromptReceipt } from './prompt.js';

function harness(defaults?: { defaultConfirmationTimeoutMs?: number }) {
  const written: string[] = [];
  const injector = createPromptInjector({ write: (d) => written.push(d), ...defaults });
  return { written, injector };
}

describe('createPromptInjector', () => {
  it('wraps the prompt in bracketed paste and submits with Enter', async () => {
    const { written, injector } = harness();
    const receiptPromise = injector.submit({ text: 'run the tests' });
    expect(written).toEqual(['\x1b[200~run the tests\x1b[201~', '\r']);

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
    const { written, injector } = harness();
    const receiptPromise = injector.submit({ text: 'line one\r\nline two\n' });
    expect(written[0]).toBe('\x1b[200~line one\nline two\x1b[201~');

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
    const { written, injector } = harness();
    injector.setPermissionPending(true);
    expect((await injector.submit({ text: 'blocked' })).status).toBe('rejected');
    expect(written).toHaveLength(0);

    injector.setPermissionPending(false);
    const receipt = injector.submit({ text: 'now ok' });
    injector.handleTurnStarted('t', 'now ok');
    expect((await receipt).status).toBe('confirmed');
  });

  it('user input during confirmation resolves uncertain (user has priority)', async () => {
    const { injector } = harness();
    const receiptPromise = injector.submit({ text: 'automation prompt' });
    injector.notifyUserInput();
    const receipt = await receiptPromise;
    expect(receipt.status).toBe('uncertain');
    expect((receipt as { reason: string }).reason).toContain('user took control');
    expect(injector.isActive()).toBe(false);
  });

  it('paste-only stages without Enter and confirms immediately', async () => {
    const { written, injector } = harness();
    const receipt = await injector.submit({ text: 'staged', mode: 'paste-only' });
    expect(receipt.status).toBe('confirmed');
    expect(written).toEqual(['\x1b[200~staged\x1b[201~']);
  });

  it('rejects empty prompts before touching the terminal', async () => {
    const { written, injector } = harness();
    expect((await injector.submit({ text: '\n' })).status).toBe('rejected');
    expect(written).toHaveLength(0);
  });

  it('times out as uncertain, never as a false confirmation', async () => {
    const { injector } = harness();
    const receipt: PromptReceipt = await injector.submit({ text: 'lost', confirmationTimeoutMs: 40 });
    expect(receipt.status).toBe('uncertain');
    expect((receipt as { reason: string }).reason).toContain('no matching UserPromptSubmit');
  });
});
