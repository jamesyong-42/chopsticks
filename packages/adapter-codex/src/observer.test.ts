import { describe, it, expect, vi } from 'vitest';
import { createCodexObserver } from './observer.js';
import type { Transport } from './app-server-client.js';

/**
 * A controllable in-memory app-server. Auto-answers `initialize` and lets a test
 * decide how many times `thread/resume` fails with "no rollout found" before it
 * succeeds — the shape of the real 0.144.4 behaviour (a thread has no rollout
 * until its first turn produces output).
 */
function controllable(resumeFailuresBeforeSuccess: number) {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((i: { code: number | null; signal: string | null }) => void) | undefined;
  let resumeFails = resumeFailuresBeforeSuccess;
  let resumeAttempts = 0;
  const transport: Transport = {
    send: (m) => {
      const msg = m as { id?: number; method?: string };
      if (msg.id === undefined) return; // client notification (e.g. initialized)
      queueMicrotask(() => {
        if (msg.method === 'thread/resume') {
          resumeAttempts++;
          if (resumeFails > 0) {
            resumeFails--;
            onMsg?.({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'no rollout found for thread id' } });
          } else {
            onMsg?.({ jsonrpc: '2.0', id: msg.id, result: {} });
          }
        } else {
          onMsg?.({ jsonrpc: '2.0', id: msg.id, result: {} }); // initialize et al.
        }
      });
    },
    onMessage: (h) => (onMsg = h),
    onClose: (h) => (onCls = h),
    close: () => {},
  };
  return {
    transport,
    deliver: (m: unknown) => onMsg?.(m),
    fireClose: () => onCls?.({ code: null, signal: null }),
    resumeAttempts: () => resumeAttempts,
  };
}

const threadStarted = { jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'th-1' } } };

describe('createCodexObserver attach resilience', () => {
  it('keeps retrying thread/resume until it succeeds, then attaches (no one-shot give-up)', async () => {
    const t = controllable(4); // rollout only materializes on the 5th resume
    const obs = await createCodexObserver({ transport: t.transport });
    const seen: string[] = [];
    obs.onEvent((e) => seen.push(e.event.type));

    expect(obs.state().lifecycle).toBe('preparing');
    t.deliver(threadStarted); // the TUI created a thread

    await vi.waitFor(() => expect(obs.state().lifecycle).toBe('ready'), { timeout: 5000 });
    expect(obs.sessionId).toBe('th-1');
    expect(seen).toContain('session.started');
    expect(t.resumeAttempts()).toBeGreaterThan(4);
    await obs.dispose();
  });

  it('stops retrying when disposed before the thread ever materializes', async () => {
    const t = controllable(Number.POSITIVE_INFINITY); // resume never succeeds
    const obs = await createCodexObserver({ transport: t.transport });
    t.deliver(threadStarted);

    await vi.waitFor(() => expect(t.resumeAttempts()).toBeGreaterThan(1), { timeout: 2000 });
    await obs.dispose();
    const attemptsAtDispose = t.resumeAttempts();

    await new Promise((r) => setTimeout(r, 600)); // longer than the backoff cap
    expect(obs.state().lifecycle).toBe('preparing');
    // The loop has stopped: no further resume attempts after dispose (allow one in-flight).
    expect(t.resumeAttempts()).toBeLessThanOrEqual(attemptsAtDispose + 1);
  });
});
