import { describe, it, expect } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { createCodexSession } from './driver.js';
import type { Transport } from './app-server-client.js';

const THREAD = '019f5d86-423a-7083-ab79-2deb044599c1';
const TURN = '019f5d86-42e2-7a03-844c-0de529f5ae8d';
const MSG = 'msg_pong';
const REASONING = 'reasoning_1';
const ROLLOUT = '/Users/x/.codex/sessions/2026/07/13/rollout-019f5d86.jsonl';
const PROMPT = 'say pong';

const userItem = { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: PROMPT }] };

/** The C1-shaped notification stream for one completed turn. */
function turnStream(): unknown[] {
  return [
    { jsonrpc: '2.0', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } } },
    { jsonrpc: '2.0', method: 'item/started', params: { item: userItem, threadId: THREAD, turnId: TURN } },
    { jsonrpc: '2.0', method: 'item/completed', params: { item: userItem, threadId: THREAD, turnId: TURN } },
    {
      jsonrpc: '2.0',
      method: 'item/started',
      params: { item: { type: 'reasoning', id: REASONING, summary: [] }, threadId: THREAD, turnId: TURN },
    },
    {
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: { threadId: THREAD, turnId: TURN, itemId: REASONING, delta: 'private thought text' },
    },
    {
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: THREAD, turnId: TURN, itemId: REASONING, delta: 'Checked the request.' },
    },
    {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          type: 'reasoning',
          id: REASONING,
          content: ['private thought text'],
          summary: ['Checked the request.'],
        },
        threadId: THREAD,
        turnId: TURN,
      },
    },
    {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD, turnId: TURN, itemId: MSG, delta: 'pong' },
    },
    {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: MSG, text: 'pong', phase: 'final_answer' },
        threadId: THREAD,
        turnId: TURN,
      },
    },
    {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null, durationMs: 1 } },
    },
  ];
}

interface Scripted {
  transport: Transport;
  sent: Array<Record<string, unknown>>;
}

/** A minimal in-memory `codex app-server`: answers requests + streams notifications. */
function scriptedAppServer(opts?: {
  onTurnStart?: (emit: (m: unknown) => void, id: number) => void;
  turnStartError?: { code: number; message: string };
}): Scripted {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  const sent: Array<Record<string, unknown>> = [];
  const emit = (m: unknown): void => void queueMicrotask(() => onMsg?.(m));
  const thread = { id: THREAD, sessionId: THREAD, path: ROLLOUT, status: { type: 'idle' } };

  const transport: Transport = {
    send: (raw) => {
      const m = raw as Record<string, unknown>;
      sent.push(m);
      if (typeof m.method !== 'string' || m.id === undefined) return; // client response/notification
      switch (m.method) {
        case 'initialize':
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          break;
        case 'thread/start':
          emit({ jsonrpc: '2.0', id: m.id, result: { thread } });
          emit({ jsonrpc: '2.0', method: 'thread/started', params: { thread } });
          break;
        case 'turn/start':
          if (opts?.turnStartError) {
            emit({ jsonrpc: '2.0', id: m.id, error: opts.turnStartError });
            break;
          }
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          if (opts?.onTurnStart) opts.onTurnStart(emit, m.id as number);
          else for (const n of turnStream()) emit(n);
          break;
        default:
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    },
    onMessage: (h) => (onMsg = h),
    onClose: (h) => (onCls = h),
    close: () => onCls?.({ code: 0, signal: null }),
  };
  return { transport, sent };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createCodexSession', () => {
  it('establishes identity and structured observation from thread/start', async () => {
    const s = scriptedAppServer();
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    expect(session.sessionId).toBe(THREAD);
    expect(session.runtimeSessionId).toBe(THREAD);
    expect(session.threadPath()).toBe(ROLLOUT);
    expect(session.observationLevel()).toBe('structured');
    await flush();
    expect(session.state().lifecycle).toBe('ready'); // thread/started -> session.started
  });

  it('submitPrompt drives a turn and reduces to a coherent state', async () => {
    const s = scriptedAppServer();
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const events: AgentEvent[] = [];
    const envelopes: AgentEventEnvelope[] = [];
    session.onEvent((e) => {
      events.push(e.event);
      envelopes.push(e);
    });

    const receipt = await session.submitPrompt({ text: PROMPT });
    expect(receipt.status).toBe('confirmed'); // deterministic — never uncertain
    await flush();

    expect(session.state().lifecycle).toBe('ready');
    expect(session.state().lastAssistantMessage).toBe('pong');
    expect(events.some((e) => e.type === 'assistant.message' && e.final === true && e.text === 'pong')).toBe(true);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
    expect(events.some((e) => e.type === 'reasoning.started')).toBe(true);
    expect(events.some((e) => e.type === 'reasoning.summary' && e.text === 'Checked the request.')).toBe(true);
    expect(session.state().activeReasoning).toBeUndefined();
    const rawThought = envelopes.find((e) => e.event.type === 'reasoning.progress');
    expect(rawThought?.nativeEvent).toMatchObject({
      method: 'item/reasoning/textDelta',
      params: { delta: 'private thought text' },
    });
    expect(JSON.stringify(rawThought?.event)).not.toContain('private thought text');

    // The turn was driven with structured input + a client message id (C4 confirm channel).
    const ts = s.sent.find((m) => m.method === 'turn/start');
    expect((ts?.params as Record<string, unknown>).input).toEqual([{ type: 'text', text: PROMPT }]);
    expect(typeof (ts?.params as Record<string, unknown>).clientUserMessageId).toBe('string');
  });

  it('observes and answers structured approval requests via the policy', async () => {
    const s = scriptedAppServer({
      onTurnStart: (emit) =>
        emit({ jsonrpc: '2.0', id: 999, method: 'execCommandApproval', params: { command: 'ls' } }),
    });
    const events: AgentEvent[] = [];
    const session = await createCodexSession({ cwd: '/x', transport: s.transport, onApproval: () => 'approved' });
    session.onEvent((e) => events.push(e.event));

    await session.submitPrompt({ text: 'run ls' });
    await flush();

    expect(events.some((e) => e.type === 'permission.requested' && e.tool === 'execCommandApproval')).toBe(true);
    expect(events.some((e) => e.type === 'permission.resolved' && e.outcome === 'allowed')).toBe(true);
    const resp = s.sent.find((m) => m.id === 999 && 'result' in m);
    expect(resp?.result).toEqual({ decision: 'approved' });
  });

  it('rejects submitPrompt when turn/start errors (no uncertain)', async () => {
    const s = scriptedAppServer({ turnStartError: { code: -32000, message: 'busy' } });
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const receipt = await session.submitPrompt({ text: 'x' });
    expect(receipt).toEqual({ status: 'rejected', reason: 'busy' });
  });

  it('emits process.exited when the transport closes', async () => {
    const s = scriptedAppServer();
    const session = await createCodexSession({ cwd: '/x', transport: s.transport });
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e.event));
    await session.dispose();
    await flush();
    expect(events.some((e) => e.type === 'process.exited')).toBe(true);
  });
});
