import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateHookSettings, type HttpHookHandler } from './settings.js';
import { verifiedHookEvents, type HookEventSpec } from './registry.js';

// The probe fixtures are the exact settings shapes Claude 2.1.207 accepted live.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../');
const probe = (file: string) => JSON.parse(readFileSync(join(repoRoot, 'probe', file), 'utf8'));

const OPTS = { endpoint: 'http://127.0.0.1:59999/hooks', tokenEnvVar: 'CHOPSTICKS_HOOK_TOKEN' };

describe('generateHookSettings', () => {
  it('defaults to the registry verified set, one matcher block per event', () => {
    const settings = generateHookSettings(OPTS);
    const verified = verifiedHookEvents();
    expect(Object.keys(settings.hooks).sort()).toEqual(verified.map((s) => s.event).sort());
    // `unverified` events must not be wired by default.
    expect(settings.hooks.StopFailure).toBeUndefined();
    expect(settings.hooks.PreCompact).toBeUndefined();
    for (const block of Object.values(settings.hooks)) {
      expect(block).toHaveLength(1);
      expect(block[0].hooks).toHaveLength(1);
    }
  });

  it('routes each event by its registry transport and carries its timeout', () => {
    const settings = generateHookSettings(OPTS);
    for (const spec of verifiedHookEvents()) {
      const handler = settings.hooks[spec.event][0].hooks[0];
      expect(handler.type, spec.event).toBe(spec.transport);
      if (handler.type === 'http') {
        expect(handler.timeout).toBe(spec.timeoutSec);
      } else {
        expect(handler.command).toContain(`-m ${spec.timeoutSec}`);
      }
    }
  });

  it('http handler is byte-identical to the live-accepted probe shape', () => {
    const probeHandler: HttpHookHandler = probe('http-probe-settings.json').hooks.UserPromptSubmit[0].hooks[0];
    const spec: HookEventSpec = {
      event: 'UserPromptSubmit',
      transport: 'http',
      confidence: 'verified-headless',
      timeoutSec: probeHandler.timeout,
    };
    const settings = generateHookSettings({
      endpoint: probeHandler.url,
      tokenEnvVar: 'CHOPSTICKS_HOOK_TOKEN',
      events: [spec],
    });
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toEqual(probeHandler);
  });

  it('command handler nests exactly like the census structure', () => {
    const censusBlock = probe('census-settings.json').hooks.SessionStart;
    const spec: HookEventSpec = {
      event: 'SessionStart',
      transport: 'command',
      confidence: 'verified-headless',
      timeoutSec: 5,
    };
    const block = generateHookSettings({ ...OPTS, events: [spec] }).hooks.SessionStart;
    // Same nesting + same handler discriminant as the shape Claude accepted.
    expect(Object.keys(block[0])).toEqual(Object.keys(censusBlock[0]));
    expect(block[0].hooks[0].type).toBe(censusBlock[0].hooks[0].type);
    expect(block[0].hooks[0]).toMatchObject({ type: 'command', command: expect.stringContaining('curl') });
  });

  it('curl forwarder posts stdin to the bridge with bearer auth', () => {
    const spec: HookEventSpec = {
      event: 'SessionEnd',
      transport: 'command',
      confidence: 'verified-headless',
      timeoutSec: 5,
    };
    const handler = generateHookSettings({ ...OPTS, events: [spec] }).hooks.SessionEnd[0].hooks[0];
    expect(handler.type).toBe('command');
    if (handler.type === 'command') {
      expect(handler.command).toContain('--data-binary @-');
      expect(handler.command).toContain('Authorization: Bearer $CHOPSTICKS_HOOK_TOKEN');
      expect(handler.command).toContain(OPTS.endpoint);
    }
  });

  it('SECURITY: only the $VAR reference is emitted, never a literal token', () => {
    const settings = generateHookSettings({ endpoint: OPTS.endpoint, tokenEnvVar: 'SECRET_ENV' });
    const serialized = JSON.stringify(settings);
    expect(serialized).toContain('$SECRET_ENV');
    for (const block of Object.values(settings.hooks)) {
      const handler = block[0].hooks[0];
      if (handler.type === 'http') {
        expect(handler.headers.Authorization).toBe('Bearer $SECRET_ENV');
        expect(handler.allowedEnvVars).toEqual(['SECRET_ENV']);
      } else {
        expect(handler.command).toContain('Bearer $SECRET_ENV');
      }
    }
  });
});
