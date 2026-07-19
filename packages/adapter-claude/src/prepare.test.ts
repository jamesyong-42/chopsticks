import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupClaudeSession, prepareClaudeSession, type PreparedClaudeSession } from './prepare.js';
import { generateHookSettings } from './settings.js';

const BASE = {
  cwd: '/work/repo',
  endpoint: 'http://127.0.0.1:4100/hooks',
  tokenEnvVar: 'CHOPSTICKS_HOOK_TOKEN',
  token: 'super-secret-token-value',
};

const prepared: PreparedClaudeSession[] = [];
const prepare = async (over: Partial<Parameters<typeof prepareClaudeSession>[0]> = {}) => {
  const p = await prepareClaudeSession({ ...BASE, ...over });
  prepared.push(p);
  return p;
};

afterEach(async () => {
  await Promise.all(prepared.splice(0).map(cleanupClaudeSession));
});

describe('prepareClaudeSession', () => {
  it('generates a UUID session id when none is supplied and keys the file by it', async () => {
    const p = await prepare();
    expect(p.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(p.settingsPath).toContain(p.sessionId);
    expect(p.args).toEqual(expect.arrayContaining(['--session-id', p.sessionId]));
  });

  it('reuses a caller-supplied session id (the spaghetti join contract)', async () => {
    const p = await prepare({ sessionId: 'fixed-session-id' });
    expect(p.sessionId).toBe('fixed-session-id');
  });

  it('round-trips: file exists and parses to the generated settings; cleanup removes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-test-'));
    const p = await prepare({ settingsDir: dir });
    expect(existsSync(p.settingsPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(p.settingsPath, 'utf8'));
    expect(onDisk).toEqual(generateHookSettings({ endpoint: BASE.endpoint, tokenEnvVar: BASE.tokenEnvVar }));

    await cleanupClaudeSession(p);
    expect(existsSync(p.settingsPath)).toBe(false);
  });

  it('mkdtemp path: owns and cleans the created directory', async () => {
    const p = await prepareClaudeSession(BASE);
    const dir = p.filesToCleanup.find((f) => f !== p.settingsPath);
    expect(dir).toBeDefined();
    expect(existsSync(dir!)).toBe(true);
    await cleanupClaudeSession(p);
    expect(existsSync(dir!)).toBe(false);
    expect(existsSync(p.settingsPath)).toBe(false);
  });

  it('a caller-supplied settingsDir is not scheduled for removal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-keep-'));
    const p = await prepare({ settingsDir: dir });
    expect(p.filesToCleanup).toEqual([p.settingsPath]);
    await cleanupClaudeSession(p);
    expect(existsSync(dir)).toBe(true); // caller's dir survives
  });

  it('SECURITY: token value never lands on disk, only in env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-sec-'));
    const p = await prepare({ settingsDir: dir });
    const text = readFileSync(p.settingsPath, 'utf8');
    expect(text).not.toContain(BASE.token);
    expect(text).toContain('$CHOPSTICKS_HOOK_TOKEN');
    expect(p.env).toEqual({ CHOPSTICKS_HOOK_TOKEN: BASE.token });
  });

  it('builds a native-interactive command and NEVER structured print flags', async () => {
    const p = await prepare({
      executable: '/opt/claude',
      title: 'my session',
      model: 'claude-fable-5',
      permissionMode: 'plan',
    });
    expect(p.command).toBe('/opt/claude');
    expect(p.args).toEqual([
      '--session-id',
      p.sessionId,
      '--name',
      'my session',
      '--model',
      'claude-fable-5',
      '--settings',
      p.settingsPath,
      '--permission-mode',
      'plan',
    ]);
    for (const forbidden of ['-p', '--print', '--output-format', '--input-format']) {
      expect(p.args).not.toContain(forbidden);
    }
  });

  it('defaults command to claude and permission-mode to default; omits --name without a title', async () => {
    const p = await prepare();
    expect(p.command).toBe('claude');
    expect(p.args).toContain('--permission-mode');
    expect(p.args[p.args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(p.args).not.toContain('--name');
  });

  it('resume uses --resume with the resumed id and NEVER --session-id (mutually exclusive)', async () => {
    const resumeId = '64a61b19-f4d8-4f96-ba56-07024b470813';
    const p = await prepare({ resume: resumeId });
    expect(p.sessionId).toBe(resumeId); // join contract preserved: same id
    expect(p.args).toContain('--resume');
    expect(p.args[p.args.indexOf('--resume') + 1]).toBe(resumeId);
    expect(p.args).not.toContain('--session-id');
    // Settings still attach on resume (the hook bridge follows a resumed session).
    expect(p.args).toContain('--settings');
  });
});
