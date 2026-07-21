/**
 * Full-loop driver test: the test acts as Claude Code. The fake spawn port
 * captures the PreparedClaudeSession exactly as the pty-host would receive
 * it; the test then reads the generated settings file to discover the bridge
 * endpoint (proving the settings are what a real Claude would consume) and
 * POSTs fixture-shaped hook payloads with the env-carried token.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope, TerminalAutomationOperation } from '@vibecook/chopsticks-core';
import { createClaudeSession, prepareClaudeTuiSession, type ClaudeSession } from './driver.js';
import type { PreparedClaudeSession } from './prepare.js';

let sessions: ClaudeSession[] = [];
afterEach(async () => {
  for (const s of sessions) await s.dispose();
  sessions = [];
});

async function startSession() {
  let prepared: PreparedClaudeSession | undefined;
  const automations: TerminalAutomationOperation[] = [];
  const session = await createClaudeSession({
    cwd: '/tmp',
    title: 'driver-test',
    ports: {
      spawn: async (p) => {
        prepared = p;
        return { runtimeSessionId: 'rt-1' };
      },
      automate: async (id, operation) => {
        expect(id).toBe('rt-1');
        automations.push(operation);
        return { accepted: true };
      },
    },
  });
  sessions.push(session);

  const settings = JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; url?: string }> }>>;
  };
  const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url!;
  const token = prepared!.env.CHOPSTICKS_HOOK_TOKEN;

  const events: AgentEventEnvelope[] = [];
  session.onEvent((e) => events.push(e));

  const hook = async (name: string, fields: Record<string, unknown> = {}) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: session.sessionId,
        transcript_path: fields.transcript_path,
        cwd: '/tmp',
        hook_event_name: name,
        ...fields,
      }),
    });
    expect(res.status).toBe(200);
  };

  return { session, prepared: prepared!, automations, events, hook };
}

describe('createClaudeSession (full loop, test-as-Claude)', () => {
  it('prepares launch wiring without spawning and adopts one existing terminal idempotently', async () => {
    const prepared = await prepareClaudeTuiSession({
      cwd: '/tmp',
      executable: '/opt/claude',
      permissionMode: 'plan',
      model: 'sonnet',
      automate: async () => ({ accepted: true }),
    });

    expect(prepared.launch).toMatchObject({
      command: '/opt/claude',
      cwd: '/tmp',
      env: { CHOPSTICKS_HOOK_TOKEN: expect.any(String) },
    });
    expect(prepared.launch.args).toEqual(
      expect.arrayContaining(['--session-id', prepared.sessionId, '--model', 'sonnet', '--permission-mode', 'plan']),
    );
    expect(existsSync(prepared.launch.settingsPath)).toBe(true);

    const first = await prepared.adopt('existing-pane');
    expect(first.runtimeSessionId).toBe('existing-pane');
    expect(await prepared.adopt('existing-pane')).toBe(first);
    await expect(prepared.adopt('other-pane')).rejects.toThrow('already adopted');

    const events: AgentEventEnvelope[] = [];
    first.onEvent((event) => events.push(event));
    const settings = JSON.parse(readFileSync(prepared.launch.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url!;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.CHOPSTICKS_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: prepared.sessionId,
        cwd: '/tmp',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'typed prompt',
        prompt_id: 'p-adopted',
      }),
    });
    expect(response.status).toBe(200);
    expect(first.observationLevel()).toBe('native-hooks');
    expect(events.some((event) => event.event.type === 'turn.started')).toBe(true);

    await prepared.dispose();
    expect(existsSync(prepared.launch.settingsPath)).toBe(false);
  });

  it('spawns via the prepared join contract and tracks the hook lifecycle in reducer state', async () => {
    const { session, prepared, hook } = await startSession();
    expect(prepared.sessionId).toBe(session.sessionId);
    expect(prepared.args).toContain('--session-id');
    expect(session.observationLevel()).toBe('terminal-only');

    await hook('SessionStart', { source: 'startup', session_title: 'driver-test' });
    expect(session.observationLevel()).toBe('native-hooks');
    expect(session.state().lifecycle).toBe('ready');

    await hook('UserPromptSubmit', { prompt: 'do something', prompt_id: 'p-1' });
    expect(session.state().lifecycle).toBe('running');
    expect(session.state().activeTurn?.id).toBe('p-1');

    await hook('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'toolu_1',
      prompt_id: 'p-1',
    });
    expect(session.state().tools.size).toBe(1);

    await hook('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_response: { ok: 1 },
      duration_ms: 3,
      prompt_id: 'p-1',
    });
    expect(session.state().tools.size).toBe(0);
    expect(session.state().counters.toolsCompleted).toBe(1);

    await hook('Stop', { prompt_id: 'p-1', last_assistant_message: 'done!' });
    expect(session.state().lifecycle).toBe('ready');
    expect(session.state().lastAssistantMessage).toBe('done!');
  });

  it('confirms injected prompts through the real bridge round-trip', async () => {
    const { session, automations, hook } = await startSession();
    await hook('SessionStart', {});

    const receiptPromise = session.submitPrompt({ text: 'injected task' });
    expect(automations).toEqual([{ kind: 'paste', text: 'injected task', submit: true }]);

    await hook('UserPromptSubmit', { prompt: 'injected task', prompt_id: 'p-9' });
    expect(await receiptPromise).toEqual({ status: 'confirmed', turnId: 'p-9' });
  });

  it('gates injection while a permission dialog is pending, releasing on allowed', async () => {
    const { session, hook } = await startSession();
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'risky', prompt_id: 'p-2' });
    await hook('PermissionRequest', { prompt_id: 'p-2', tool_name: 'Bash', tool_input: { command: 'rm x' } });

    expect((await session.submitPrompt({ text: 'nope' })).status).toBe('rejected');
    expect(session.state().permissions.size).toBe(1);

    await hook('PreToolUse', {
      prompt_id: 'p-2',
      tool_name: 'Bash',
      tool_input: { command: 'rm x' },
      tool_use_id: 'toolu_2',
    });
    expect(session.state().permissions.size).toBe(0);

    const receipt = session.submitPrompt({ text: 'now fine' });
    await hook('UserPromptSubmit', { prompt: 'now fine', prompt_id: 'p-3' });
    expect((await receipt).status).toBe('confirmed');
  });

  it('feeds authoritative assistant text from the transcript observer', async () => {
    const { session, events, hook } = await startSession();
    const dir = mkdtempSync(join(tmpdir(), 'driver-transcript-'));
    const transcript = join(dir, `${session.sessionId}.jsonl`);
    writeFileSync(transcript, '');

    await hook('SessionStart', { transcript_path: transcript });
    expect(session.transcriptPath()).toBe(transcript);

    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'u1',
        timestamp: '2026-07-13T00:00:00.000Z',
        message: {
          id: 'msg_real',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'authoritative answer' }],
          stop_reason: null,
        },
      })}\n`,
    );
    await session.pollTranscript();

    const fromTranscript = events.find((e) => e.source === 'native-transcript');
    expect(fromTranscript?.event).toMatchObject({
      type: 'assistant.message',
      text: 'authoritative answer',
      displayOnly: false,
    });
    expect(session.state().lastAssistantMessage).toBe('authoritative answer');
  });

  it('dispose tears down the bridge and removes the generated settings', async () => {
    const { session, prepared, hook } = await startSession();
    await hook('SessionStart', {});
    expect(existsSync(prepared.settingsPath)).toBe(true);

    await session.dispose();
    sessions = [];
    expect(existsSync(prepared.settingsPath)).toBe(false);
  });

  it('resume spawns with the resumed id and its bridge accepts only that session', async () => {
    const resumeId = '64a61b19-f4d8-4f96-ba56-07024b470813';
    let prepared: PreparedClaudeSession | undefined;
    const session = await createClaudeSession({
      cwd: '/tmp',
      resume: resumeId,
      ports: {
        spawn: async (p) => {
          prepared = p;
          return { runtimeSessionId: 'rt-resume' };
        },
        automate: async () => ({ accepted: true }),
      },
    });
    sessions.push(session);

    expect(session.sessionId).toBe(resumeId);
    expect(prepared!.args).toContain('--resume');
    expect(prepared!.args).not.toContain('--session-id');

    // The bridge is scoped to the resumed id — a hook for it lands in state.
    const endpoint = (
      JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
      }
    ).hooks.UserPromptSubmit[0].hooks[0].url!;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${prepared!.env.CHOPSTICKS_HOOK_TOKEN}` },
      body: JSON.stringify({ session_id: resumeId, cwd: '/tmp', hook_event_name: 'SessionStart' }),
    });
    expect(res.status).toBe(200);
    expect(session.observationLevel()).toBe('native-hooks');
  });
});
