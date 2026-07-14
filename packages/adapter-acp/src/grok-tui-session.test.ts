import { describe, it, expect } from 'vitest';
import { createInitialSessionState, type AgentEventEnvelope, type AgentSession } from '@vibecook/chopsticks-core';
import { createPendingControlSession } from './grok-tui-session.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A controllable fake ACP control session (the thing the TUI session attaches). */
function fakeControl() {
  const listeners = new Set<(e: AgentEventEnvelope) => void>();
  let disposed = false;
  const session: AgentSession = {
    sessionId: 'ctl',
    runtimeSessionId: 'ctl-rt',
    state: () => ({ ...createInitialSessionState(), lifecycle: 'ready' }),
    observationLevel: () => 'structured',
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    submitPrompt: async () => ({ status: 'confirmed', turnId: 't1' }),
    notifyUserInput: () => undefined,
    dispose: async () => {
      disposed = true;
    },
  };
  return {
    session,
    emit: (e: AgentEventEnvelope) => listeners.forEach((l) => l(e)),
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

/** A promise whose resolution is controlled externally. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPendingControlSession', () => {
  it('exposes id + terminal immediately, structured level, initial state before attach', () => {
    const s = createPendingControlSession('sid', 'rt', () => new Promise<AgentSession>(() => {}));
    expect(s.sessionId).toBe('sid');
    expect(s.runtimeSessionId).toBe('rt');
    expect(s.observationLevel()).toBe('structured');
    expect(s.state().lifecycle).toBe('preparing'); // initial reducer state until control lands
  });

  it('buffers onEvent listeners and forwards them once control attaches', async () => {
    const ctl = fakeControl();
    const d = deferred<AgentSession>();
    const s = createPendingControlSession('sid', 'rt', () => d.promise);

    const got: AgentEventEnvelope[] = [];
    s.onEvent((e) => got.push(e));
    ctl.emit(ENVELOPE); // before attach: nothing is wired yet
    expect(got).toHaveLength(0);

    d.resolve(ctl.session);
    await tick();
    ctl.emit(ENVELOPE); // after attach: the buffered listener receives it
    expect(got).toHaveLength(1);
    expect(got[0]!.event.type).toBe('session.ready');

    // state() now delegates to the attached control.
    expect(s.state().lifecycle).toBe('ready');
  });

  it('submitPrompt awaits the attach, then delegates to the control client', async () => {
    const ctl = fakeControl();
    const d = deferred<AgentSession>();
    const s = createPendingControlSession('sid', 'rt', () => d.promise);

    const pending = s.submitPrompt({ text: 'hi' }); // called BEFORE attach
    d.resolve(ctl.session);
    const receipt = await pending;
    expect(receipt).toEqual({ status: 'confirmed', turnId: 't1' });
  });

  it('submitPrompt rejects when control never attaches', async () => {
    const s = createPendingControlSession('sid', 'rt', () => Promise.reject(new Error('nope')));
    const receipt = await s.submitPrompt({ text: 'hi' });
    expect(receipt.status).toBe('rejected');
  });

  it('dispose() before attach cancels the eventual control client', async () => {
    const ctl = fakeControl();
    const d = deferred<AgentSession>();
    const s = createPendingControlSession('sid', 'rt', () => d.promise);

    await s.dispose(); // disposed before control lands
    d.resolve(ctl.session);
    await tick();
    expect(ctl.disposed).toBe(true); // the late-arriving control is torn down, not leaked
  });

  it('dispose() after attach disposes the control client', async () => {
    const ctl = fakeControl();
    const s = createPendingControlSession('sid', 'rt', () => Promise.resolve(ctl.session));
    await tick(); // let attach land
    await s.dispose();
    expect(ctl.disposed).toBe(true);
  });
});
