import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AgentEvent, AgentEventEnvelope } from './events.js';
import { createEnvelopeStamper } from './events.js';
import { createInitialSessionState, reduceSessionState, type SessionRuntimeState } from './state.js';

function stampAll(events: AgentEvent[]): AgentEventEnvelope[] {
  const stamper = createEnvelopeStamper();
  return events.map((event, i) =>
    stamper.next({
      sessionId: 's-1',
      timestamp: '2026-07-12T00:00:00.000Z',
      monotonicTime: i,
      source: 'native-hook',
      confidence: 'authoritative',
      event,
    }),
  );
}

function replay(envelopes: AgentEventEnvelope[], initial = createInitialSessionState()): SessionRuntimeState {
  return envelopes.reduce(reduceSessionState, initial);
}

const id = fc.constantFrom('a', 'b', 'c', 'd');

const arbitraryEvent: fc.Arbitrary<AgentEvent> = fc.oneof(
  fc.constant<AgentEvent>({ type: 'session.started' }),
  fc.constant<AgentEvent>({ type: 'session.ready' }),
  id.map((turnId): AgentEvent => ({ type: 'turn.started', turnId, prompt: `p-${turnId}` })),
  id.map((turnId): AgentEvent => ({ type: 'turn.completed', turnId, lastAssistantMessage: `m-${turnId}` })),
  id.map((turnId): AgentEvent => ({ type: 'turn.failed', turnId })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool.requested', toolCallId, tool: 'Bash' })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool.started', toolCallId })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool.completed', toolCallId })),
  id.map((toolCallId): AgentEvent => ({ type: 'tool.failed', toolCallId })),
  id.map((requestId): AgentEvent => ({ type: 'permission.requested', requestId, presentation: 'native-tui' })),
  id.map((requestId): AgentEvent => ({ type: 'permission.resolved', requestId, outcome: 'allowed' })),
  id.map((subagentId): AgentEvent => ({ type: 'subagent.started', subagentId })),
  id.map((subagentId): AgentEvent => ({ type: 'subagent.stopped', subagentId })),
  id.map((taskId): AgentEvent => ({ type: 'task.created', taskId })),
  id.map((taskId): AgentEvent => ({ type: 'task.completed', taskId })),
  fc.constant<AgentEvent>({ type: 'assistant.message', text: 'hello' }),
  fc.constant<AgentEvent>({ type: 'session.exited', reason: 'other' }),
  fc.constant<AgentEvent>({ type: 'process.exited', reason: 'completed', exitCode: 0 }),
  fc.constant<AgentEvent>({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: 'Mystery' }),
);

const arbitraryEvents = fc.array(arbitraryEvent, { maxLength: 40 });

describe('reduceSessionState properties (DESIGN §26.5)', () => {
  it('replaying the same log produces the same state, without mutating the initial state', () => {
    fc.assert(
      fc.property(arbitraryEvents, (events) => {
        const envelopes = stampAll(events);
        const initial = createInitialSessionState();
        const snapshot = structuredClone(initial);
        const a = replay(envelopes, initial);
        const b = replay(envelopes);
        expect(a).toEqual(b);
        expect(initial).toEqual(snapshot);
      }),
    );
  });

  it('duplicate envelopes do not change the outcome', () => {
    fc.assert(
      fc.property(arbitraryEvents, fc.nat(), (events, pick) => {
        fc.pre(events.length > 0);
        const envelopes = stampAll(events);
        const i = pick % envelopes.length;
        const withDuplicate = [...envelopes.slice(0, i + 1), envelopes[i], ...envelopes.slice(i + 1)];
        expect(replay(withDuplicate)).toEqual(replay(envelopes));
      }),
    );
  });

  it('never throws on out-of-order application', () => {
    fc.assert(
      fc.property(arbitraryEvents, fc.array(fc.nat(), { maxLength: 40 }), (events, order) => {
        const envelopes = stampAll(events);
        fc.pre(envelopes.length > 0);
        let state = createInitialSessionState();
        for (const n of order) {
          state = reduceSessionState(state, envelopes[n % envelopes.length]);
        }
      }),
    );
  });
});

describe('reduceSessionState transitions', () => {
  it('completed tools leave the active-tool map', () => {
    const state = replay(
      stampAll([
        { type: 'tool.requested', toolCallId: 't1', tool: 'Read' },
        { type: 'tool.requested', toolCallId: 't2', tool: 'Bash' },
        { type: 'tool.completed', toolCallId: 't1' },
        { type: 'tool.failed', toolCallId: 't2' },
      ]),
    );
    expect(state.tools.size).toBe(0);
    expect(state.counters.toolsCompleted).toBe(1);
    expect(state.counters.toolsFailed).toBe(1);
  });

  it('tracks explicit reasoning independently and clears it at turn completion', () => {
    const mid = replay(
      stampAll([
        { type: 'turn.started', turnId: 'p1' },
        { type: 'reasoning.started', reasoningId: 'r1' },
        { type: 'tool.started', toolCallId: 't1', tool: 'command' },
      ]),
    );
    expect(mid.activeReasoning).toMatchObject({ reasoningId: 'r1' });
    expect(mid.tools.has('t1')).toBe(true);

    const done = replay(
      stampAll([
        { type: 'turn.started', turnId: 'p1' },
        { type: 'reasoning.started', reasoningId: 'r1' },
        { type: 'turn.completed', turnId: 'p1' },
      ]),
    );
    expect(done.activeReasoning).toBeUndefined();
  });

  it('session exit ends the active turn and clears in-flight tools with diagnostics', () => {
    const state = replay(
      stampAll([
        { type: 'session.started' },
        { type: 'turn.started', turnId: 'p1' },
        { type: 'tool.requested', toolCallId: 't1', tool: 'Bash' },
        { type: 'session.exited', reason: 'other' },
      ]),
    );
    expect(state.lifecycle).toBe('exited');
    expect(state.activeTurn).toBeUndefined();
    expect(state.tools.size).toBe(0);
    expect(state.diagnostics.map((d) => d.code)).toEqual(['turn-orphaned-on-exit', 'tools-orphaned-on-exit']);
  });

  it('permission events cannot overwrite unrelated tool state', () => {
    const state = replay(
      stampAll([
        { type: 'tool.requested', toolCallId: 'x', tool: 'Bash' },
        { type: 'permission.requested', requestId: 'x', toolCallId: 'x', presentation: 'native-tui' },
        { type: 'permission.resolved', requestId: 'x', outcome: 'denied' },
      ]),
    );
    expect(state.tools.get('x')).toMatchObject({ tool: 'Bash', state: 'requested' });
    expect(state.permissions.size).toBe(0);
  });

  it('unknown event types are counted, never thrown', () => {
    const bogus = stampAll([{ type: 'wat.is-this' } as unknown as AgentEvent]);
    const state = replay(bogus);
    expect(state.counters.unknownEvents).toBe(1);
  });

  it('turn lifecycle: started → running, completed → ready with last assistant message', () => {
    const mid = replay(stampAll([{ type: 'session.started' }, { type: 'turn.started', turnId: 'p1' }]));
    expect(mid.lifecycle).toBe('running');
    expect(mid.activeTurn?.id).toBe('p1');
    const done = replay(
      stampAll([
        { type: 'session.started' },
        { type: 'turn.started', turnId: 'p1' },
        { type: 'turn.completed', turnId: 'p1', lastAssistantMessage: 'ok' },
      ]),
    );
    expect(done.lifecycle).toBe('ready');
    expect(done.activeTurn).toBeUndefined();
    expect(done.lastAssistantMessage).toBe('ok');
  });

  it('crash-like process exits mark the session failed', () => {
    const state = replay(
      stampAll([{ type: 'session.started' }, { type: 'process.exited', reason: 'crash', exitCode: 1 }]),
    );
    expect(state.lifecycle).toBe('failed');
    expect(state.exit).toEqual({ exitCode: 1, signal: undefined, reason: 'crash' });
  });

  it('diagnostics are bounded', () => {
    const events: AgentEvent[] = [{ type: 'session.exited', reason: 'other' }];
    for (let i = 0; i < 200; i++) events.push({ type: 'turn.started', turnId: `p${i}` });
    const state = replay(stampAll(events));
    expect(state.diagnostics.length).toBeLessThanOrEqual(50);
  });
});
