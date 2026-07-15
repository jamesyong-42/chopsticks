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
  const calls: { method?: string; params?: unknown }[] = [];
  const transport: Transport = {
    send: (m) => {
      const msg = m as { id?: number; method?: string; params?: unknown };
      if (msg.id === undefined) return; // client notification (e.g. initialized)
      calls.push({ method: msg.method, params: msg.params });
      queueMicrotask(() => {
        if (msg.method === 'thread/resume') {
          resumeAttempts++;
          if (resumeFails > 0) {
            resumeFails--;
            onMsg?.({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'no rollout found for thread id' } });
          } else {
            onMsg?.({ jsonrpc: '2.0', id: msg.id, result: {} });
          }
        } else if (msg.method === 'thread/start') {
          onMsg?.({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              thread: {
                id: 'th-owned',
                sessionId: 'th-owned',
                path: '/tmp/rollout-th-owned.jsonl',
              },
            },
          });
        } else {
          onMsg?.({ jsonrpc: '2.0', id: msg.id, result: {} }); // initialize, inject_items, …
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
    calls: () => calls,
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

describe('createCodexObserver controller-owned bootstrap', () => {
  it('start: thread/start → inject_items → resume → ready with session id', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({
      transport: t.transport,
      start: { cwd: '/tmp/ws', sandbox: 'read-only', approvalPolicy: 'never' },
    });

    // Bootstrap completes before createCodexObserver resolves — ready immediately,
    // no user prompt required (the workbench panel "preparing" fix).
    expect(obs.sessionId).toBe('th-owned');
    expect(obs.threadPath()).toBe('/tmp/rollout-th-owned.jsonl');
    expect(obs.state().lifecycle).toBe('ready');

    const methods = t.calls().map((c) => c.method);
    expect(methods).toContain('thread/start');
    expect(methods).toContain('thread/inject_items');
    expect(methods).toContain('thread/resume');

    const inject = t.calls().find((c) => c.method === 'thread/inject_items');
    expect(inject?.params).toEqual({
      threadId: 'th-owned',
      items: [{ type: 'text', text: '' }],
    });

    const start = t.calls().find((c) => c.method === 'thread/start');
    expect(start?.params).toMatchObject({
      cwd: '/tmp/ws',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });

    await obs.dispose();
  });

  it('threadId: resumes a known id and is ready immediately', async () => {
    const t = controllable(0);
    const obs = await createCodexObserver({
      transport: t.transport,
      threadId: 'th-resume-me',
    });
    expect(obs.sessionId).toBe('th-resume-me');
    expect(obs.state().lifecycle).toBe('ready');
    expect(t.calls().some((c) => c.method === 'thread/start')).toBe(false);
    expect(t.calls().some((c) => c.method === 'thread/resume')).toBe(true);
    await obs.dispose();
  });

  it('rejects threadId + start together', async () => {
    const t = controllable(0);
    await expect(
      createCodexObserver({
        transport: t.transport,
        threadId: 'x',
        start: { cwd: '/tmp' },
      }),
    ).rejects.toThrow(/threadId OR start/);
  });
});
