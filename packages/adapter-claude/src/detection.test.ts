import { describe, expect, it } from 'vitest';
import { detectClaude, type ClaudeExec } from './detection.js';

const FULL_HELP = `Usage: claude [options] [prompt]

Options:
  --session-id <uuid>         Use a specific session ID (must be a valid UUID)
  -n, --name <name>           Name the session
  --settings <file-or-json>   Path to a settings JSON file or a JSON string
  --permission-mode <mode>    Permission mode to use (default: "default")
  -p, --print                 Print response and exit (structured mode)
  -h, --help                  Display help`;

/** Fake exec: routes on the probed subcommand, with per-call failure hooks. */
function fakeExec(
  opts: { version?: string; help?: string; failVersion?: boolean; failHelp?: boolean } = {},
): ClaudeExec {
  return async (_file, args) => {
    if (args.includes('--version')) {
      if (opts.failVersion) throw new Error('spawn ENOENT');
      return { stdout: opts.version ?? '2.1.207 (Claude Code)' };
    }
    if (opts.failHelp) throw new Error('spawn ENOENT');
    return { stdout: opts.help ?? FULL_HELP };
  };
}

describe('detectClaude', () => {
  it('all flags present → parsed version, all flags true, no warnings', async () => {
    const result = await detectClaude({ executable: 'claude', exec: fakeExec() });
    expect(result.version).toBe('2.1.207');
    expect(result.flags).toEqual({ sessionId: true, settings: true, name: true, permissionMode: true });
    expect(result.warnings).toEqual([]);
  });

  it('recognizes the short -n form for --name', async () => {
    const help = FULL_HELP.replace(/^.*--name.*$/m, '  -n <name>                   Name the session');
    const result = await detectClaude({ exec: fakeExec({ help }) });
    expect(result.flags.name).toBe(true);
  });

  it('missing --session-id → flags.sessionId false + a warning', async () => {
    const help = FULL_HELP.split('\n')
      .filter((line) => !line.includes('--session-id'))
      .join('\n');
    const result = await detectClaude({ exec: fakeExec({ help }) });
    expect(result.flags.sessionId).toBe(false);
    expect(result.flags.settings).toBe(true);
    expect(result.warnings.some((w) => w.includes('--session-id'))).toBe(true);
  });

  it('unparseable version → warning, version undefined, flags still probed', async () => {
    const result = await detectClaude({ exec: fakeExec({ version: 'claude code (dev build)' }) });
    expect(result.version).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('could not parse version'))).toBe(true);
    expect(result.flags.settings).toBe(true);
  });

  it('does not throw when the binary cannot be run; degrades to all-false flags', async () => {
    const result = await detectClaude({ exec: fakeExec({ failVersion: true, failHelp: true }) });
    expect(result.version).toBeUndefined();
    expect(result.flags).toEqual({ sessionId: false, settings: false, name: false, permissionMode: false });
    // one --version failure + one --help failure + four missing-flag warnings
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('resolution order: explicit executable wins over the env override', async () => {
    const prev = process.env.CHOPSTICKS_CLAUDE_BIN;
    process.env.CHOPSTICKS_CLAUDE_BIN = '/env/claude';
    try {
      const explicit = await detectClaude({ executable: '/opt/claude', exec: fakeExec() });
      expect(explicit.executable).toBe('/opt/claude');
      const fromEnv = await detectClaude({ exec: fakeExec() });
      expect(fromEnv.executable).toBe('/env/claude');
    } finally {
      if (prev === undefined) delete process.env.CHOPSTICKS_CLAUDE_BIN;
      else process.env.CHOPSTICKS_CLAUDE_BIN = prev;
    }
  });
});

// Opt-in: probes the actually-installed Claude binary. Skipped unless asked.
const realClaude = process.env.CHOPSTICKS_REAL_CLAUDE === '1';
describe.skipIf(!realClaude)('detectClaude against the real binary', () => {
  it('reports a version and the four required flags', async () => {
    const result = await detectClaude();
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.flags).toEqual({ sessionId: true, settings: true, name: true, permissionMode: true });
    expect(result.warnings).toEqual([]);
  });
});
