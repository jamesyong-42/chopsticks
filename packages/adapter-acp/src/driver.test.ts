import { describe, it, expect } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { createAcpSession } from './driver.js';
import { scriptedAcpConnector } from './scripted-connector.js';

const SID = '019f5e50-ce8b-7152-abcd-000000000001';

/** Drive one turn to completion, resolving when turn.completed is observed. */
async function driveTurn(session: Awaited<ReturnType<typeof createAcpSession>>, text: string): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const off = session.onEvent((e) => {
      if (e.event.type === 'turn.completed' || e.event.type === 'turn.failed') {
        off();
        resolve();
      }
    });
  });
  await session.submitPrompt({ text });
  await done;
}

describe('createAcpSession', () => {
  it('exposes the ACP session id and a structured observation level', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    try {
      expect(session.sessionId).toBe(SID);
      expect(session.runtimeSessionId).toBe(SID);
      expect(session.observationLevel()).toBe('structured');
    } finally {
      await session.dispose();
    }
  });

  it('drives a turn: running while active, ready after, reply sealed, deterministic receipt', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    const lifecycles = new Set<string>([session.state().lifecycle]);
    const seqs: number[] = [];
    const off = session.onEvent((e: AgentEventEnvelope) => {
      lifecycles.add(session.state().lifecycle);
      seqs.push(e.sequence);
    });
    try {
      const receipt = await session.submitPrompt({ text: 'say pong' });
      expect(receipt.status).toBe('confirmed');
      if (receipt.status === 'confirmed') expect(receipt.turnId).toBe('acp-turn-1');

      // wait for turn.completed
      await new Promise<void>((resolve) => {
        const stop = session.onEvent((e) => {
          if (e.event.type === 'turn.completed') {
            stop();
            resolve();
          }
        });
      });

      expect(lifecycles.has('running')).toBe(true);
      expect(session.state().lifecycle).toBe('ready');
      expect(session.state().activeTurn).toBeUndefined();
      expect(session.state().lastAssistantMessage).toBe('pong');
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    } finally {
      off();
      await session.dispose();
    }
  });

  it('records tool completion through a tool turn', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'done', toolTurn: true }),
    });
    try {
      await driveTurn(session, 'use a tool');
      expect(session.state().counters.toolsCompleted).toBe(1);
      expect(session.state().tools.size).toBe(0);
      expect(session.state().lastAssistantMessage).toBe('done');
    } finally {
      await session.dispose();
    }
  });

  it('dispose() is idempotent', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'pong' }),
    });
    await session.dispose();
    await expect(session.dispose()).resolves.toBeUndefined();
  });
});
