/**
 * Opt-in live test — drives the REAL `codex app-server` through the hand-written
 * client + driver (not a scripted transport). Skipped unless CODEX_LIVE=1, like
 * adapter-claude's real-agent group. Read-only sandbox + approval "never":
 * the turn cannot write, network, or prompt.
 *
 *   CODEX_LIVE=1 pnpm --filter @vibecook/chopsticks-adapter-codex test
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexSession } from './driver.js';

const live = process.env.CODEX_LIVE === '1';

describe.skipIf(!live)('createCodexSession (live codex app-server)', () => {
  it('drives a real turn and observes the assistant reply', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-live-'));
    const session = await createCodexSession({ cwd, sandbox: 'read-only', approvalPolicy: 'never' });
    try {
      expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);
      expect(session.observationLevel()).toBe('structured');

      const receipt = await session.submitPrompt({
        text: 'Reply with exactly the single word: pong. Do not run any commands or use any tools.',
      });
      expect(receipt.status).toBe('confirmed');

      // Wait for the turn to complete via the observed event stream.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no turn.completed within 60s')), 60_000);
        session.onEvent((e) => {
          if (e.event.type === 'turn.completed' || e.event.type === 'turn.failed') {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      expect(session.state().lastAssistantMessage?.toLowerCase()).toContain('pong');
      expect(session.threadPath()).toContain('.codex/sessions/');
    } finally {
      await session.dispose();
    }
  }, 70_000);
});
