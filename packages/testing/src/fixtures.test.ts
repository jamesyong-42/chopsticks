import { describe, expect, it } from 'vitest';
import { fakeClaudeHookPayload, listHookFixtureEvents, loadHookFixtures } from './index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('captured hook fixtures (Phase 0)', () => {
  it('covers the events observed by the probe', () => {
    expect(listHookFixtureEvents()).toEqual(
      expect.arrayContaining([
        'InstructionsLoaded',
        'MessageDisplay',
        'PostToolUse',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ]),
    );
  });

  it('every record carries the common envelope and matches its file', () => {
    for (const event of listHookFixtureEvents()) {
      const records = loadHookFixtures(event);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.hook_event_name).toBe(event);
        expect(record.session_id).toMatch(UUID_RE);
        expect(record.transcript_path).toContain(record.session_id);
        expect(typeof record.cwd).toBe('string');
      }
    }
  });

  it('tool events carry tool_use_id; prompts carry prompt and prompt_id', () => {
    for (const record of loadHookFixtures('PreToolUse')) {
      expect(record.tool_use_id).toMatch(/^toolu_/);
      expect(record.tool_name).toBeDefined();
    }
    for (const record of loadHookFixtures('UserPromptSubmit')) {
      expect(typeof record.prompt).toBe('string');
      expect(record.prompt_id).toMatch(UUID_RE);
    }
  });

  it('MessageDisplay fixtures have the streaming shape found by the probe', () => {
    for (const record of loadHookFixtures('MessageDisplay')) {
      expect(typeof record.delta).toBe('string');
      expect(typeof record.final).toBe('boolean');
      expect(record.turn_id).toMatch(UUID_RE);
      expect(record.message_id).toMatch(UUID_RE);
    }
  });
});

// Interactive-only events (M1): captured by driving a real native TUI
// (packages/node/scripts/interactive-census.mjs); these never fire in headless
// `-p` mode. Shapes documented in draft/HOOK-SURFACE-FINDINGS.md §3.
describe('interactive-only hook fixtures (M1)', () => {
  it('PermissionRequest carries the pending tool but NO tool_use_id (correlate via prompt_id)', () => {
    const records = loadHookFixtures('PermissionRequest');
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.prompt_id).toMatch(UUID_RE);
      expect(typeof record.tool_name).toBe('string');
      expect(typeof record.tool_input).toBe('object');
      // The permission gate fires before a tool_use_id is assigned: correlation
      // to PreToolUse is by (prompt_id + tool_name + tool_input), not tool id.
      expect(record.tool_use_id).toBeUndefined();
      expect(Array.isArray(record.permission_suggestions)).toBe(true);
    }
  });

  it('Notification identifies the reason it interrupted', () => {
    const records = loadHookFixtures('Notification');
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(typeof record.notification_type).toBe('string');
      expect(typeof record.message).toBe('string');
    }
  });

  it('PostToolUseFailure carries tool_use_id + an error string (approved tool that failed)', () => {
    const records = loadHookFixtures('PostToolUseFailure');
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.tool_use_id).toMatch(/^toolu_/);
      expect(typeof record.tool_name).toBe('string');
      expect(typeof record.error).toBe('string');
      expect(typeof record.is_interrupt).toBe('boolean');
    }
  });

  it('SubagentStart/Stop carry agent_id + agent_type; Stop adds the agent transcript path', () => {
    for (const record of loadHookFixtures('SubagentStart')) {
      expect(typeof record.agent_id).toBe('string');
      expect((record.agent_id as string).length).toBeGreaterThan(0);
      expect(typeof record.agent_type).toBe('string');
    }
    for (const record of loadHookFixtures('SubagentStop')) {
      expect(typeof record.agent_id).toBe('string');
      expect(typeof record.agent_type).toBe('string');
      expect(record.agent_transcript_path).toContain(record.agent_id as string);
      expect(record.last_assistant_message).toBeDefined();
    }
  });
});

describe('fakeClaudeHookPayload', () => {
  it('builds the common envelope and applies overrides', () => {
    const payload = fakeClaudeHookPayload('PermissionRequest', { tool_name: 'Bash', session_id: 'abc' });
    expect(payload.hook_event_name).toBe('PermissionRequest');
    expect(payload.session_id).toBe('abc');
    expect(payload.transcript_path).toContain('abc');
    expect(payload.tool_name).toBe('Bash');
  });
});
