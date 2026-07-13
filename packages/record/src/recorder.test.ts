import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionRecorder } from './recorder.js';

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'record-')), 'own-actions.jsonl');
}

describe('createActionRecorder', () => {
  it('stamps ts and round-trips typed actions through read()', async () => {
    const recorder = createActionRecorder({ path: tmpLog(), now: () => new Date('2026-07-13T00:00:00.000Z') });
    await recorder.record({
      type: 'injection',
      sessionId: 's-1',
      text: 'do the thing',
      outcome: 'confirmed',
      turnId: 'p-1',
    });
    await recorder.record({
      type: 'workspace-final',
      sessionId: 's-1',
      isolation: 'worktree',
      branch: 'chopsticks/ab12',
      filesTouched: ['a.ts', 'b.ts'],
      retained: true,
    });

    const actions = await recorder.read();
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      ts: '2026-07-13T00:00:00.000Z',
      type: 'injection',
      sessionId: 's-1',
      text: 'do the thing',
      outcome: 'confirmed',
      turnId: 'p-1',
    });
    expect(actions[1]).toMatchObject({ type: 'workspace-final', retained: true, filesTouched: ['a.ts', 'b.ts'] });
  });

  it('serializes concurrent records without interleaving (one line each)', async () => {
    const recorder = createActionRecorder({ path: tmpLog() });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        recorder.record({ type: 'session-exit', sessionId: `s-${i}`, exitCode: i, reason: 'completed' }),
      ),
    );
    const actions = await recorder.read();
    expect(actions).toHaveLength(50);
    expect(new Set(actions.map((a) => (a as { sessionId: string }).sessionId)).size).toBe(50);
  });

  it('creates the parent directory on first write', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'record-')), 'nested', 'deep', 'own-actions.jsonl');
    const recorder = createActionRecorder({ path });
    await recorder.record({ type: 'policy-conflict', sessionId: 's', code: 'WORKSPACE_CONFLICT', message: 'busy' });
    expect(existsSync(path)).toBe(true);
    expect(await recorder.read()).toHaveLength(1);
  });

  it('read() returns [] for a log that does not exist yet', async () => {
    const recorder = createActionRecorder({ path: tmpLog() });
    expect(await recorder.read()).toEqual([]);
  });

  it('a write failure surfaces on onError, never throwing into the caller', async () => {
    const errors: Error[] = [];
    // A path whose parent is a FILE, not a directory: mkdir will fail.
    const fileAsParent = tmpLog();
    const recorder = createActionRecorder({ path: fileAsParent });
    await recorder.record({ type: 'session-exit', sessionId: 's', exitCode: 0, reason: 'completed' }); // creates the file
    const broken = createActionRecorder({ path: join(fileAsParent, 'child.jsonl'), onError: (e) => errors.push(e) });
    await expect(
      broken.record({ type: 'session-exit', sessionId: 's', exitCode: 0, reason: 'completed' }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
