import { runAgentSessionConformance, type AgentSessionHarness } from '@vibecook/chopsticks-testing/conformance';
import { createCodexSession } from './driver.js';
import type { Transport } from './app-server-client.js';

const THREAD = '019f5d86-423a-7083-ab79-2deb044599c1';
const TURN = 'turn-conformance-1';
const REPLY = 'pong';

/** A minimal scripted `codex app-server` that completes one turn with `reply`. */
function scriptedAppServer(reply: string): Transport {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  const emit = (m: unknown): void => void queueMicrotask(() => onMsg?.(m));
  const thread = { id: THREAD, sessionId: THREAD, path: '/rollout.jsonl', status: { type: 'idle' } };
  const userItem = { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'go' }] };

  return {
    send: (raw) => {
      const m = raw as Record<string, unknown>;
      if (typeof m.method !== 'string' || m.id === undefined) return;
      switch (m.method) {
        case 'initialize':
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          break;
        case 'thread/start':
          emit({ jsonrpc: '2.0', id: m.id, result: { thread } });
          emit({ jsonrpc: '2.0', method: 'thread/started', params: { thread } });
          break;
        case 'turn/start':
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
          emit({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } },
          });
          emit({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: { item: userItem, threadId: THREAD, turnId: TURN },
          });
          emit({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              item: { type: 'agentMessage', id: 'msg', text: reply, phase: 'final_answer' },
              threadId: THREAD,
              turnId: TURN,
            },
          });
          emit({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null } },
          });
          break;
        default:
          emit({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    },
    onMessage: (h) => (onMsg = h),
    onClose: (h) => (onCls = h),
    close: () => onCls?.({ code: 0, signal: null }),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

runAgentSessionConformance('codex', async (): Promise<AgentSessionHarness> => {
  const session = await createCodexSession({ cwd: '/x', transport: scriptedAppServer(REPLY) });
  await tick(); // let the thread/started notification apply -> ready
  return {
    session,
    reply: REPLY,
    driveTurn: async () => {
      const done = new Promise<void>((resolve) => {
        const off = session.onEvent((e) => {
          if (e.event.type === 'turn.completed') {
            off();
            resolve();
          }
        });
      });
      await session.submitPrompt({ text: 'go' });
      await done;
    },
  };
});
