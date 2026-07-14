/**
 * Live ACP driver test — drives REAL `grok agent stdio` through the generic
 * driver (opt-in: `GROK_LIVE=1`). Proves the same path the A1 spike proved, but
 * through the shipped `createAcpSession` + normalizer + reducer, not a throwaway
 * script. Set `CHOPSTICKS_GROK_BIN` to override the executable.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpSession } from './driver.js';

const live = process.env.GROK_LIVE === '1';
const GROK_BIN = process.env.CHOPSTICKS_GROK_BIN ?? 'grok';

describe.skipIf(!live)('createAcpSession (live grok)', () => {
  it('initializes, opens a session, and completes a pong turn', async () => {
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'grok-acp-live-'));
    const session = await createAcpSession({ cwd, executable: GROK_BIN, args: ['agent', 'stdio'] });

    try {
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.observationLevel()).toBe('structured');

      const completed = new Promise<{ stopReason?: string }>((resolve) => {
        const off = session.onEvent((e) => {
          if (e.event.type === 'turn.completed') {
            off();
            resolve({ stopReason: e.event.stopReason });
          }
        });
      });

      const receipt = await session.submitPrompt({
        text: 'Reply with exactly the single word: pong. Do not use any tools.',
      });
      expect(receipt.status).toBe('confirmed');

      const { stopReason } = await completed;
      expect(stopReason).toBe('end_turn');
      expect((session.state().lastAssistantMessage ?? '').toLowerCase()).toContain('pong');
      expect(session.state().lifecycle).toBe('ready');
    } finally {
      await session.dispose();
    }
  }, 60_000);
});
