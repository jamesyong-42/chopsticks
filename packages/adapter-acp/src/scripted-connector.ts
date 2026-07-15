/**
 * A scripted in-memory ACP connector for tests — the sibling of the Codex
 * adapter's `scriptedAppServer`. It fakes an ACP `Agent` that completes one turn
 * (optionally with a tool call), driving the client handler's `sessionUpdate`
 * exactly as a real agent would over the wire, then resolving `session/prompt`
 * with a stop reason. Excluded from the published build (see tsconfig.build.json).
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, Client, PromptRequest, PromptResponse } from '@agentclientprotocol/sdk';
import type { AcpConnector } from './connection.js';

export interface ScriptedAcpOptions {
  sessionId: string;
  reply: string;
  /** Also drive a tool_call + tool_call_update pair during the turn. */
  toolTurn?: boolean;
  /** Also emit a protocol thought chunk before visible activity. */
  thought?: string;
}

export function scriptedAcpConnector(opts: ScriptedAcpOptions): AcpConnector {
  const { sessionId, reply, toolTurn, thought } = opts;
  return (toClient) => {
    let onCls: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    let client: Client;

    const agent = {
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
      },
      async newSession() {
        return { sessionId };
      },
      async loadSession() {
        return {};
      },
      async prompt(params: PromptRequest): Promise<PromptResponse> {
        const promptText = params.prompt[0] && params.prompt[0].type === 'text' ? params.prompt[0].text : '';
        // Echo the user's prompt (agents stream this back; the normalizer drops it).
        await client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } },
        });
        if (thought) {
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              messageId: 'thought-1',
              content: { type: 'text', text: thought },
            },
          });
        }
        if (toolTurn) {
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc1',
              title: 'run',
              kind: 'execute',
              status: 'in_progress',
            },
          });
          await client.sessionUpdate({
            sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', rawOutput: 'ok' },
          });
        }
        // Stream the assistant reply in two chunks to exercise delta accumulation.
        const mid = Math.ceil(reply.length / 2);
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: reply.slice(0, mid) },
          },
        });
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: reply.slice(mid) },
          },
        });
        return { stopReason: 'end_turn' };
      },
      async cancel() {
        /* no-op */
      },
    };

    client = toClient(agent as unknown as Agent);

    return {
      agent: agent as unknown as Agent,
      onClose: (handler) => {
        onCls = handler;
      },
      close: () => {
        onCls?.({ code: 0, signal: null });
      },
    };
  };
}
