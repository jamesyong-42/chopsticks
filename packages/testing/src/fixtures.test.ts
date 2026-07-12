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

describe('fakeClaudeHookPayload', () => {
  it('builds the common envelope and applies overrides', () => {
    const payload = fakeClaudeHookPayload('PermissionRequest', { tool_name: 'Bash', session_id: 'abc' });
    expect(payload.hook_event_name).toBe('PermissionRequest');
    expect(payload.session_id).toBe('abc');
    expect(payload.transcript_path).toContain('abc');
    expect(payload.tool_name).toBe('Bash');
  });
});
