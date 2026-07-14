/**
 * Opt-in live test — the Model-B observe flow against real Codex. One connection
 * (a driver, standing in for the native TUI) creates + drives a thread; a
 * separate observer connection attaches via thread/started -> thread/resume and
 * must see the same turn. Skipped unless CODEX_LIVE=1.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexSession } from './driver.js';
import { createCodexObserver } from './observer.js';
import { spawnAppServer, wsOverUnixTransport } from './ws-transport.js';

const live = process.env.CODEX_LIVE === '1';

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!live)('createCodexObserver (live, Model B)', () => {
  it('attaches to a thread another connection created and observes its turn', async () => {
    const server = spawnAppServer();
    await server.ready();
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'codex-obs-'));

    // Observer connects first and waits for a thread to appear.
    const observer = await createCodexObserver({ transport: wsOverUnixTransport(server.socketPath) });
    const attached = new Promise<void>((res) => observer.onThread(() => res()));

    // Driver (stands in for the native TUI) creates + drives the thread.
    const driver = await createCodexSession({
      cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      transport: wsOverUnixTransport(server.socketPath),
    });

    try {
      // Turn 1 materializes the thread (writes its rollout) so the observer's
      // retrying thread/resume can attach — a thread has no rollout before its
      // first user message.
      const turn1 = new Promise<void>((res) => {
        const off = driver.onEvent((e) => {
          if (e.event.type === 'turn.completed') {
            off();
            res();
          }
        });
      });
      await driver.submitPrompt({ text: 'Reply with exactly the single word: ready.' });
      await turn1;
      await attached;
      expect(observer.sessionId).toBe(driver.sessionId);
      expect(observer.observationLevel()).toBe('structured');

      // Turn 2 is observed live through the attached stream.
      await driver.submitPrompt({
        text: 'Reply with exactly the single word: pong. Do not run any commands or use any tools.',
      });
      await waitFor(() => (observer.state().lastAssistantMessage ?? '').toLowerCase().includes('pong'), 60_000);
      expect(observer.state().lastAssistantMessage?.toLowerCase()).toContain('pong');
    } finally {
      await observer.dispose();
      await driver.dispose();
      server.dispose();
    }
  }, 90_000);
});
