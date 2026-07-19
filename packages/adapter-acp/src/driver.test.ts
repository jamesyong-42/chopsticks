import { describe, it, expect, vi } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, Client, ClientCapabilities, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AcpConnector } from './connection.js';
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

  it('surfaces thought presence, retains the raw payload, and closes reasoning before the answer', async () => {
    const session = await createAcpSession({
      cwd: '/x',
      connector: scriptedAcpConnector({ sessionId: SID, reply: 'done', thought: 'private thought text' }),
    });
    const envelopes: AgentEventEnvelope[] = [];
    const off = session.onEvent((envelope) => envelopes.push(envelope));
    try {
      await driveTurn(session, 'think first');
      const started = envelopes.find((envelope) => envelope.event.type === 'reasoning.started');
      const completed = envelopes.find((envelope) => envelope.event.type === 'reasoning.completed');
      const answer = envelopes.find((envelope) => envelope.event.type === 'assistant.message');
      expect(started?.event).toEqual({ type: 'reasoning.started', reasoningId: 'thought-1' });
      expect(started?.nativeEvent).toMatchObject({
        update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'private thought text' } },
      });
      expect(completed?.confidence).toBe('derived');
      expect(completed!.sequence).toBeLessThan(answer!.sequence);
      expect(JSON.stringify(started?.event)).not.toContain('private thought text');
      expect(session.state().activeReasoning).toBeUndefined();
    } finally {
      off();
      await session.dispose();
    }
  });

  it('forwards client capabilities and structured approvals to the ACP seam', async () => {
    const clientCapabilities: ClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: true,
    };
    let initializedCapabilities: ClientCapabilities | undefined;
    let permissionResponse: RequestPermissionResponse | undefined;
    let client!: Client;
    const connector: AcpConnector = (toClient) => {
      const agent = {
        async initialize(params: { clientCapabilities?: ClientCapabilities }) {
          initializedCapabilities = params.clientCapabilities;
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
        },
        async newSession() {
          return { sessionId: SID };
        },
        async prompt() {
          permissionResponse = await client.requestPermission({
            sessionId: SID,
            toolCall: {
              toolCallId: 'tool-1',
              title: 'Write file',
              kind: 'edit',
              rawInput: { path: 'README.md' },
            },
            options: [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
            ],
          });
          return { stopReason: 'end_turn' as const };
        },
        async cancel() {},
      };
      client = toClient(agent as unknown as Agent);
      return {
        agent: agent as unknown as Agent,
        onClose() {},
        close() {},
      };
    };
    const onApproval = vi.fn(() => 'approved' as const);
    const session = await createAcpSession({ cwd: '/x', connector, clientCapabilities, onApproval });
    const events: string[] = [];
    const off = session.onEvent((envelope) => events.push(envelope.event.type));

    try {
      await driveTurn(session, 'write the file');
      expect(initializedCapabilities).toEqual(clientCapabilities);
      expect(onApproval).toHaveBeenCalledWith({
        toolCallId: 'tool-1',
        tool: 'Write file',
        input: { path: 'README.md' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      expect(permissionResponse).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(events).toEqual(expect.arrayContaining(['permission.requested', 'permission.resolved']));
    } finally {
      off();
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
