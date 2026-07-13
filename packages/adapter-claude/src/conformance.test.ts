import { readFileSync } from 'node:fs';
import { runAgentSessionConformance, type AgentSessionHarness } from '@vibecook/chopsticks-testing/conformance';
import { createClaudeSession } from './driver.js';
import type { PreparedClaudeSession } from './prepare.js';

const REPLY = 'done!';

/** Build a live ClaudeSession driven through its real hook bridge (test-as-Claude). */
async function claudeHarness(): Promise<AgentSessionHarness> {
  let prepared: PreparedClaudeSession | undefined;
  const session = await createClaudeSession({
    cwd: '/tmp',
    title: 'conformance',
    ports: {
      spawn: async (p) => {
        prepared = p;
        return { runtimeSessionId: 'rt-conformance' };
      },
      write: () => undefined,
    },
  });

  const settings = JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
  };
  const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url!;
  const token = prepared!.env.CHOPSTICKS_HOOK_TOKEN;

  const hook = async (name: string, fields: Record<string, unknown> = {}): Promise<void> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: session.sessionId, cwd: '/tmp', hook_event_name: name, ...fields }),
    });
    if (res.status !== 200) throw new Error(`hook ${name} -> ${res.status}`);
  };

  await hook('SessionStart', {}); // -> ready, native-hooks

  let turn = 0;
  return {
    session,
    reply: REPLY,
    driveTurn: async (prompt) => {
      const promptId = `p-${++turn}`;
      await hook('UserPromptSubmit', { prompt, prompt_id: promptId });
      await hook('Stop', { prompt_id: promptId, last_assistant_message: REPLY });
    },
  };
}

runAgentSessionConformance('claude', claudeHarness);
