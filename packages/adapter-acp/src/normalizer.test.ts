import { describe, it, expect } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AcpNotificationNormalizer } from './normalizer.js';

const SID = 'sess-1';
const note = (update: SessionNotification['update']): SessionNotification => ({ sessionId: SID, update });

describe('AcpNotificationNormalizer', () => {
  it('accumulates agent_message_chunk deltas into a single assistant.message', () => {
    const n = new AcpNotificationNormalizer();
    const a = n.normalize(
      note({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'po' } }),
    );
    const b = n.normalize(
      note({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'ng' } }),
    );

    expect(a.events).toEqual([
      { type: 'assistant.message', messageId: 'm1', text: 'po', final: false, displayOnly: false },
    ]);
    expect(b.events).toEqual([
      { type: 'assistant.message', messageId: 'm1', text: 'pong', final: false, displayOnly: false },
    ]);
    expect(n.assistantText('m1')).toBe('pong');
  });

  it('drops user_message_chunk (the prompt echo)', () => {
    const n = new AcpNotificationNormalizer();
    const r = n.normalize(note({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }));
    expect(r.events).toEqual([]);
  });

  it('retains agent_thought_chunk as a native-event (no first-class reasoning event)', () => {
    const n = new AcpNotificationNormalizer();
    const r = n.normalize(note({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }));
    expect(r.events).toEqual([{ type: 'adapter.native-event', adapter: 'acp', nativeType: 'agent_thought_chunk' }]);
  });

  it('maps tool_call → tool.started and tool_call_update(completed) → tool.completed', () => {
    const n = new AcpNotificationNormalizer();
    const started = n.normalize(
      note({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'run', kind: 'execute', status: 'in_progress' }),
    );
    const done = n.normalize(
      note({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', rawOutput: 'ok' }),
    );

    expect(started.events).toEqual([{ type: 'tool.started', toolCallId: 'tc1', tool: 'execute' }]);
    expect(done.events).toEqual([{ type: 'tool.completed', toolCallId: 'tc1', tool: undefined, output: 'ok' }]);
  });

  it('emits tool.started AND tool.completed when a tool_call arrives already completed', () => {
    const n = new AcpNotificationNormalizer();
    const r = n.normalize(
      note({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc2',
        title: 'read',
        kind: 'read',
        status: 'completed',
        rawOutput: 'x',
      }),
    );
    expect(r.events).toEqual([
      { type: 'tool.started', toolCallId: 'tc2', tool: 'read' },
      { type: 'tool.completed', toolCallId: 'tc2', tool: 'read', output: 'x' },
    ]);
  });

  it('maps tool_call_update(failed) → tool.failed', () => {
    const n = new AcpNotificationNormalizer();
    const r = n.normalize(note({ sessionUpdate: 'tool_call_update', toolCallId: 'tc3', status: 'failed' }));
    expect(r.events).toEqual([{ type: 'tool.failed', toolCallId: 'tc3', tool: undefined }]);
  });

  it('drops intermediate tool_call_update(in_progress) — covered by tool.started', () => {
    const n = new AcpNotificationNormalizer();
    const r = n.normalize(note({ sessionUpdate: 'tool_call_update', toolCallId: 'tc4', status: 'in_progress' }));
    expect(r.events).toEqual([]);
  });

  it('retains unmodeled kinds (available_commands_update) as native-events (ADR-008)', () => {
    const n = new AcpNotificationNormalizer();
    const r = n.normalize(note({ sessionUpdate: 'available_commands_update', availableCommands: [] }));
    expect(r.events).toEqual([
      { type: 'adapter.native-event', adapter: 'acp', nativeType: 'available_commands_update' },
    ]);
  });
});
