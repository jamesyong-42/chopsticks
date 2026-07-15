/** Opt-in live coverage of Grok's direct ACP-over-stdio command. */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpSession, createStdioAcpConnector } from '@vibecook/chopsticks-adapter-acp';
import { describe, expect, it } from 'vitest';

const live = process.env.GROK_LIVE === '1';
const GROK_BIN = process.env.CHOPSTICKS_GROK_BIN ?? 'grok';

describe.skipIf(!live)('Grok ACP composition (live)', () => {
  it('initializes, opens a session, and completes a pong turn', async () => {
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'grok-acp-live-'));
    const session = await createAcpSession({
      cwd,
      connector: createStdioAcpConnector({ executable: GROK_BIN, args: ['agent', 'stdio'], cwd }),
    });

    try {
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.observationLevel()).toBe('structured');

      const completed = new Promise<{ stopReason?: string }>((resolve) => {
        const off = session.onEvent((event) => {
          if (event.event.type === 'turn.completed') {
            off();
            resolve({ stopReason: event.event.stopReason });
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
