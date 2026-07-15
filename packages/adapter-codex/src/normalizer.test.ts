import { describe, it, expect } from 'vitest';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type SessionRuntimeState,
} from '@vibecook/chopsticks-core';
import { CodexNotificationNormalizer, type CodexServerNotification } from './normalizer.js';

// Real identifiers + payloads from the C1 live capture
// (probe/codex/c1-appserver-capture.jsonl).
const THREAD = '019f5d86-423a-7083-ab79-2deb044599c1';
const TURN = '019f5d86-42e2-7a03-844c-0de529f5ae8d';
const USER_ITEM = '019f5d86-46ef-7db2-bde0-eac915e62d86';
const MSG = 'msg_03ea82984e64b11a016a5561de1a4c8198a0861b2e87ca80af';
const PROMPT = 'Reply with exactly the single word: pong. Do not run any commands or use any tools.';

const userItem = {
  type: 'userMessage',
  id: USER_ITEM,
  clientId: null,
  content: [{ type: 'text', text: PROMPT, text_elements: [] }],
};

/** The captured single-turn notification stream, in the order Codex emitted it. */
const CAPTURE: CodexServerNotification[] = [
  {
    method: 'thread/started',
    params: { thread: { id: THREAD, sessionId: THREAD, preview: '', name: null, status: { type: 'idle' } } },
  },
  { method: 'remoteControl/status/changed', params: { status: 'disabled' } }, // ambient
  { method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } } },
  { method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active' } } }, // ambient
  { method: 'item/started', params: { item: userItem, threadId: THREAD, turnId: TURN } },
  { method: 'item/completed', params: { item: userItem, threadId: THREAD, turnId: TURN } },
  {
    method: 'item/started',
    params: {
      item: { type: 'agentMessage', id: MSG, text: '', phase: 'final_answer' },
      threadId: THREAD,
      turnId: TURN,
    },
  },
  { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: MSG, delta: 'pong' } },
  {
    method: 'item/completed',
    params: {
      item: { type: 'agentMessage', id: MSG, text: 'pong', phase: 'final_answer' },
      threadId: THREAD,
      turnId: TURN,
    },
  },
  {
    method: 'thread/tokenUsage/updated',
    params: { threadId: THREAD, turnId: TURN, tokenUsage: { total: { totalTokens: 13505 } } },
  },
  { method: 'account/rateLimits/updated', params: {} }, // ambient
  {
    method: 'turn/completed',
    params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null, durationMs: 2480 } },
  },
];

function normalizeAll(caps: CodexServerNotification[]): AgentEvent[] {
  const n = new CodexNotificationNormalizer();
  return caps.flatMap((c) => n.normalize(c).events);
}

describe('CodexNotificationNormalizer', () => {
  it('maps a real single-turn app-server stream onto core events', () => {
    const events = normalizeAll(CAPTURE);

    const started = events.filter((e) => e.type === 'session.started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ nativeSessionId: THREAD });

    // turn.started is deferred to the userMessage so it carries id AND prompt,
    // and it is emitted exactly once (not duplicated by the defensive flush).
    const turnStarts = events.filter((e) => e.type === 'turn.started');
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]).toMatchObject({ turnId: TURN, prompt: PROMPT });

    // Streaming delta: accumulated text, not yet final.
    const deltas = events.filter((e) => e.type === 'assistant.message' && e.final === false);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ messageId: MSG, text: 'pong', displayOnly: false });

    // Authoritative final assistant message from item/completed.
    const finals = events.filter((e) => e.type === 'assistant.message' && e.final === true);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ messageId: MSG, turnId: TURN, text: 'pong' });

    const completed = events.filter((e) => e.type === 'turn.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ turnId: TURN });
  });

  it('retains unmodeled-but-relevant notifications and drops pure infra', () => {
    // token usage has no home in the union → retained (ADR-008), not dropped.
    const tokens = new CodexNotificationNormalizer().normalize(CAPTURE[9]!);
    expect(tokens.events).toEqual([
      { type: 'adapter.native-event', adapter: 'codex', nativeType: 'thread/tokenUsage/updated' },
    ]);

    // pure infra/account/UI churn → dropped entirely.
    for (const m of [
      'remoteControl/status/changed',
      'thread/status/changed',
      'account/rateLimits/updated',
      'mcpServer/startupStatus/updated',
    ]) {
      expect(new CodexNotificationNormalizer().normalize({ method: m, params: {} }).events).toEqual([]);
    }
  });

  it('surfaces the userMessage clientId for injection confirmation', () => {
    const n = new CodexNotificationNormalizer();
    n.normalize(CAPTURE[2]!); // turn/started
    const completed = n.normalize({
      method: 'item/completed',
      params: { item: { ...userItem, clientId: 'inj-42' }, threadId: THREAD, turnId: TURN },
    });
    expect(completed.userMessageClientId).toBe('inj-42');
  });

  it('maps reasoning presence and user-displayable summaries without copying raw thought text', () => {
    const n = new CodexNotificationNormalizer();
    const events = [
      ...n.normalize({
        method: 'item/started',
        params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'r1', summary: [] } },
      }).events,
      ...n.normalize({
        method: 'item/reasoning/textDelta',
        params: { threadId: THREAD, turnId: TURN, itemId: 'r1', delta: 'private thought text' },
      }).events,
      ...n.normalize({
        method: 'item/reasoning/summaryTextDelta',
        params: { threadId: THREAD, turnId: TURN, itemId: 'r1', delta: 'Checked both approaches.' },
      }).events,
      ...n.normalize({
        method: 'item/completed',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: 'reasoning',
            id: 'r1',
            content: ['private thought text'],
            summary: ['Checked both approaches.'],
          },
        },
      }).events,
    ];

    expect(events).toEqual([
      { type: 'reasoning.started', reasoningId: 'r1' },
      { type: 'reasoning.progress', reasoningId: 'r1' },
      { type: 'reasoning.summary', reasoningId: 'r1', text: 'Checked both approaches.', final: false },
      { type: 'reasoning.completed', reasoningId: 'r1' },
    ]);
    expect(JSON.stringify(events)).not.toContain('private thought text');
  });

  it('a failed turn normalizes to turn.failed with the error', () => {
    const n = new CodexNotificationNormalizer();
    n.normalize(CAPTURE[2]!); // turn/started
    const out = n.normalize({
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'failed', error: { message: 'model error' } } },
    });
    // defensive turn.started flush (no userMessage) + turn.failed
    expect(out.events).toEqual([
      { type: 'turn.started', turnId: TURN, prompt: undefined },
      { type: 'turn.failed', turnId: TURN, error: 'model error' },
    ]);
  });

  it('drives the core reducer to a coherent end state', () => {
    const n = new CodexNotificationNormalizer();
    const stamper = createEnvelopeStamper();
    let state: SessionRuntimeState = createInitialSessionState();
    for (const cap of CAPTURE) {
      for (const event of n.normalize(cap).events) {
        const envelope = stamper.next({
          sessionId: THREAD,
          nativeSessionId: THREAD,
          timestamp: '2026-07-13T17:08:30.000Z',
          monotonicTime: 0,
          source: 'native-hook',
          confidence: 'authoritative',
          event,
        });
        state = reduceSessionState(state, envelope);
      }
    }
    expect(state.lifecycle).toBe('ready');
    expect(state.activeTurn).toBeUndefined();
    expect(state.lastAssistantMessage).toBe('pong');
    expect(state.counters.unknownEvents).toBeGreaterThanOrEqual(1); // the retained tokenUsage
  });
});
