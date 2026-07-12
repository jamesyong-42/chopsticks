import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeAgentBin, type CapturedHookRecord } from './index.js';

function startAgent(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [fakeAgentBin], { env: { ...process.env, ...env } });
  let output = '';
  const waiters: Array<{ pattern: string; resolve: () => void }> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (output.includes(waiters[i].pattern)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  });

  return {
    write: (s: string) => child.stdin.write(s),
    waitFor(pattern: string, timeoutMs = 5000): Promise<void> {
      if (output.includes(pattern)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${JSON.stringify(pattern)}; output so far:\n${output}`)),
          timeoutMs,
        );
        waiters.push({
          pattern,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    waitForExit(): Promise<number | null> {
      return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    },
  };
}

function readHooks(file: string): CapturedHookRecord[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CapturedHookRecord);
}

describe('fake-agent', () => {
  it('echoes input and emits the Claude-shaped hook lifecycle', async () => {
    const hooksFile = join(mkdtempSync(join(tmpdir(), 'fake-agent-')), 'hooks.jsonl');
    const agent = startAgent({ FAKE_AGENT_HOOKS_FILE: hooksFile });
    await agent.waitFor('ready');
    agent.write('hello\n');
    await agent.waitFor('echo: hello');
    agent.write('/exit\n');
    expect(await agent.waitForExit()).toBe(0);

    const events = readHooks(hooksFile);
    expect(events.map((e) => e.hook_event_name)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'UserPromptSubmit',
      'SessionEnd',
    ]);
    const [, promptEvent, stopEvent] = events;
    expect(promptEvent.prompt).toBe('hello');
    expect(stopEvent.last_assistant_message).toBe('echo: hello');
    expect(stopEvent.prompt_id).toBe(promptEvent.prompt_id);
  });

  it('strips bracketed-paste markers and treats pasted content as input', async () => {
    const agent = startAgent();
    await agent.waitFor('ready');
    agent.write('\x1b[200~pasted text\x1b[201~\r');
    await agent.waitFor('echo: pasted text');
    agent.write('/exit\n');
    await agent.waitForExit();
  });

  it('emits paired PreToolUse/PostToolUse with a shared tool_use_id', async () => {
    const hooksFile = join(mkdtempSync(join(tmpdir(), 'fake-agent-')), 'hooks.jsonl');
    const agent = startAgent({ FAKE_AGENT_HOOKS_FILE: hooksFile });
    await agent.waitFor('ready');
    agent.write('/tool\n');
    await agent.waitFor('tool done');
    agent.write('/exit\n');
    await agent.waitForExit();

    const events = readHooks(hooksFile);
    const pre = events.find((e) => e.hook_event_name === 'PreToolUse');
    const post = events.find((e) => e.hook_event_name === 'PostToolUse');
    expect(pre?.tool_use_id).toMatch(/^toolu_fake_/);
    expect(post?.tool_use_id).toBe(pre?.tool_use_id);
    expect(post?.tool_response).toEqual({ ok: true });
  });

  it('/crash exits nonzero', async () => {
    const agent = startAgent();
    await agent.waitFor('ready');
    agent.write('/crash\n');
    expect(await agent.waitForExit()).toBe(1);
  });
});
