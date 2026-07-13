import { describe, expect, it } from 'vitest';
import { fakeClaudeHookPayload, listHookFixtureEvents, loadHookFixtures } from '@vibecook/chopsticks-testing';
import { ClaudeHookNormalizer, type ClaudeHookPayload } from './normalizer.js';
import { getHookSpec } from './registry.js';

const normalizeOne = (body: ClaudeHookPayload) => new ClaudeHookNormalizer().normalize(body);

describe('registry coverage', () => {
  it('every captured fixture event is registered as verified', () => {
    for (const event of listHookFixtureEvents()) {
      const spec = getHookSpec(event);
      expect(spec, `registry entry for ${event}`).toBeDefined();
      expect(spec!.confidence).not.toBe('unverified');
    }
  });
});

describe('ClaudeHookNormalizer against captured fixtures', () => {
  it('normalizes every fixture payload without throwing, extracting the envelope', () => {
    const normalizer = new ClaudeHookNormalizer();
    for (const record of loadHookFixtures()) {
      const result = normalizer.normalize(record as ClaudeHookPayload);
      expect(result.events.length, record.hook_event_name).toBeGreaterThan(0);
      expect(result.sessionId).toBe(record.session_id);
      expect(result.transcriptPath).toBe(record.transcript_path);
    }
  });

  it('maps the turn lifecycle: prompt → turn.started, Stop → turn.completed', () => {
    const [prompt] = loadHookFixtures('UserPromptSubmit');
    const started = normalizeOne(prompt as ClaudeHookPayload);
    expect(started.events[0]).toMatchObject({ type: 'turn.started', turnId: prompt.prompt_id, prompt: prompt.prompt });

    const [stop] = loadHookFixtures('Stop');
    const completed = normalizeOne(stop as ClaudeHookPayload);
    expect(completed.events[0]).toMatchObject({
      type: 'turn.completed',
      lastAssistantMessage: stop.last_assistant_message,
    });
  });

  it('maps tool events with their native ids', () => {
    const [pre] = loadHookFixtures('PreToolUse');
    expect(normalizeOne(pre as ClaudeHookPayload).events.at(-1)).toMatchObject({
      type: 'tool.requested',
      toolCallId: pre.tool_use_id,
      tool: pre.tool_name,
    });

    const [post] = loadHookFixtures('PostToolUse');
    expect(normalizeOne(post as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'tool.completed',
      toolCallId: post.tool_use_id,
      durationMs: post.duration_ms,
    });

    const [failure] = loadHookFixtures('PostToolUseFailure');
    expect(normalizeOne(failure as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'tool.failed',
      toolCallId: failure.tool_use_id,
    });
  });

  it('surfaces MessageDisplay turn_id for envelope stamping', () => {
    const [display] = loadHookFixtures('MessageDisplay');
    const result = normalizeOne(display as ClaudeHookPayload);
    expect(result.turnId).toBe(display.turn_id);
    expect(result.promptId).toBe(display.prompt_id);
    expect(result.events[0]).toMatchObject({ type: 'assistant.message', messageId: display.message_id });
  });
});

describe('MessageDisplay delta accumulation', () => {
  it('accumulates per message_id and finalizes', () => {
    const normalizer = new ClaudeHookNormalizer();
    const chunk = (delta: string, final: boolean) =>
      normalizer.normalize(
        fakeClaudeHookPayload('MessageDisplay', {
          message_id: 'm-1',
          turn_id: 't-1',
          delta,
          final,
          index: 0,
        }) as ClaudeHookPayload,
      ).events[0] as { text: string; final?: boolean };

    expect(chunk('Hel', false).text).toBe('Hel');
    expect(chunk('lo', false).text).toBe('Hello');
    const done = chunk('!', true);
    expect(done.text).toBe('Hello!');
    expect(done.final).toBe(true);
    // Buffer cleared: a new message starts fresh.
    expect(chunk('x', false).text).toBe('x');
  });
});

describe('permission correlation (no native request id)', () => {
  it('synthesizes a request id and resolves allowed when the matching PreToolUse arrives', () => {
    const normalizer = new ClaudeHookNormalizer();
    const [permission] = loadHookFixtures('PermissionRequest');
    const requested = normalizer.normalize(permission as ClaudeHookPayload);
    const requestedEvent = requested.events[0] as { type: string; requestId: string };
    expect(requestedEvent.type).toBe('permission.requested');
    expect(requestedEvent.requestId).toContain(String(permission.prompt_id));
    expect(normalizer.pendingPermissionRequests()).toHaveLength(1);

    const pre = fakeClaudeHookPayload('PreToolUse', {
      session_id: permission.session_id,
      prompt_id: permission.prompt_id,
      tool_name: permission.tool_name,
      tool_input: permission.tool_input,
      tool_use_id: 'toolu_after_allow',
    });
    const resolved = normalizer.normalize(pre as ClaudeHookPayload);
    expect(resolved.events[0]).toEqual({
      type: 'permission.resolved',
      requestId: requestedEvent.requestId,
      outcome: 'allowed',
    });
    expect(resolved.events[1]).toMatchObject({ type: 'tool.requested', toolCallId: 'toolu_after_allow' });
    expect(normalizer.pendingPermissionRequests()).toHaveLength(0);
  });

  it('denied permissions stay pending (absence pattern — resolution is the tracker’s job)', () => {
    const normalizer = new ClaudeHookNormalizer();
    const [permission] = loadHookFixtures('PermissionRequest');
    normalizer.normalize(permission as ClaudeHookPayload);
    // An unrelated tool executing does not resolve it.
    normalizer.normalize(
      fakeClaudeHookPayload('PreToolUse', {
        prompt_id: permission.prompt_id,
        tool_name: 'Read',
        tool_use_id: 'toolu_other',
      }) as ClaudeHookPayload,
    );
    expect(normalizer.pendingPermissionRequests()).toHaveLength(1);
  });
});

describe('SubagentStop re-entrancy', () => {
  it('normalizes only the first stop per agent; repeats stay native', () => {
    const normalizer = new ClaudeHookNormalizer();
    const [stop] = loadHookFixtures('SubagentStop');
    expect(normalizer.normalize(stop as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'subagent.stopped',
      subagentId: stop.agent_id,
    });
    expect(normalizer.normalize({ ...stop, stop_hook_active: true } as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'adapter.native-event',
      nativeType: 'SubagentStop',
    });
  });
});

describe('unknown events (ADR-008)', () => {
  it('retains unrecognized hook names as adapter.native-event', () => {
    const result = normalizeOne(fakeClaudeHookPayload('SomeFutureEvent') as ClaudeHookPayload);
    expect(result.events[0]).toEqual({
      type: 'adapter.native-event',
      adapter: 'claude-code',
      nativeType: 'SomeFutureEvent',
    });
  });
});
