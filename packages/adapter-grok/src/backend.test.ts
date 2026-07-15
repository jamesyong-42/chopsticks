import { describe, expect, it } from 'vitest';
import { createInitialSessionState, type AgentEventEnvelope, type AgentSession } from '@vibecook/chopsticks-core';
import { createPendingControlSession } from './backend.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeControl() {
  const listeners = new Set<(event: AgentEventEnvelope) => void>();
  let disposed = false;
  const session: AgentSession = {
    sessionId: 'ctl',
    runtimeSessionId: 'ctl-rt',
    state: () => ({ ...createInitialSessionState(), lifecycle: 'ready' }),
    observationLevel: () => 'structured',
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submitPrompt: async () => ({ status: 'confirmed', turnId: 't1' }),
    notifyUserInput: () => undefined,
    dispose: async () => {
      disposed = true;
    },
  };
  return {
    session,
    emit: (event: AgentEventEnvelope) => listeners.forEach((listener) => listener(event)),
    get disposed() {
      return disposed;
    },
  };
}

const ENVELOPE: AgentEventEnvelope = {
  sequence: 1,
  sessionId: 'sid',
  timestamp: '2026-07-14T00:00:00.000Z',
  monotonicTime: 0,
  source: 'native-hook',
  confidence: 'authoritative',
  event: { type: 'session.ready' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPendingControlSession', () => {
  it('exposes id + terminal immediately and initial state before attach', () => {
    const session = createPendingControlSession('sid', 'rt', () => new Promise<AgentSession>(() => {}));
    expect(session.sessionId).toBe('sid');
    expect(session.runtimeSessionId).toBe('rt');
    expect(session.observationLevel()).toBe('structured');
    expect(session.state().lifecycle).toBe('preparing');
  });

  it('forwards buffered listeners once control attaches', async () => {
    const control = fakeControl();
    const pending = deferred<AgentSession>();
    const session = createPendingControlSession('sid', 'rt', () => pending.promise);
    const received: AgentEventEnvelope[] = [];
    session.onEvent((event) => received.push(event));

    control.emit(ENVELOPE);
    expect(received).toHaveLength(0);
    pending.resolve(control.session);
    await tick();
    control.emit(ENVELOPE);

    expect(received).toHaveLength(1);
    expect(session.state().lifecycle).toBe('ready');
  });

  it('waits for attach before delegating prompt submission', async () => {
    const control = fakeControl();
    const pending = deferred<AgentSession>();
    const session = createPendingControlSession('sid', 'rt', () => pending.promise);

    const receiptPending = session.submitPrompt({ text: 'hi' });
    pending.resolve(control.session);
    await expect(receiptPending).resolves.toEqual({ status: 'confirmed', turnId: 't1' });
  });

  it('rejects prompt submission when control does not attach', async () => {
    const session = createPendingControlSession('sid', 'rt', () => Promise.reject(new Error('nope')));
    await expect(session.submitPrompt({ text: 'hi' })).resolves.toMatchObject({ status: 'rejected' });
  });

  it('disposes a control client that arrives after the TUI session closed', async () => {
    const control = fakeControl();
    const pending = deferred<AgentSession>();
    const session = createPendingControlSession('sid', 'rt', () => pending.promise);

    await session.dispose();
    pending.resolve(control.session);
    await tick();
    expect(control.disposed).toBe(true);
  });

  it('disposes an attached control client', async () => {
    const control = fakeControl();
    const session = createPendingControlSession('sid', 'rt', () => Promise.resolve(control.session));
    await tick();
    await session.dispose();
    expect(control.disposed).toBe(true);
  });
});
