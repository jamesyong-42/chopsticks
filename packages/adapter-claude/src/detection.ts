/**
 * Claude executable detection and capability probe (DESIGN §10, §16.2 steps
 * 1–3). Capability-probe, don't assume: we read `claude --version` and
 * `claude --help` and report which of the four flags the native driver depends
 * on (--session-id, --settings, --name/-n, --permission-mode) are advertised.
 *
 * Missing flags DEGRADE the observation (warnings + false in `flags`); they do
 * not throw — DESIGN §10 says report degraded capability, and a session may
 * still be spawnable with a subset. The exec function is injected so unit tests
 * run against fakes; the real binary is exercised only by the opt-in
 * integration test gated on CHOPSTICKS_REAL_CLAUDE.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Injected process runner; the default wraps node:child_process execFile. */
export type ClaudeExec = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface ClaudeFlagSupport {
  sessionId: boolean;
  settings: boolean;
  name: boolean;
  permissionMode: boolean;
}

export interface ClaudeDetection {
  /** The resolved command (an absolute path, or a bare name left to PATH). */
  executable: string;
  /** Parsed `x.y.z` from `--version`; undefined when it could not be read. */
  version?: string;
  flags: ClaudeFlagSupport;
  /** Non-fatal capability gaps (missing flags, unreadable version). */
  warnings: string[];
}

export interface DetectClaudeOptions {
  executable?: string;
  exec?: ClaudeExec;
}

const execFileAsync = promisify(execFile);

const defaultExec: ClaudeExec = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return { stdout };
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `2.1.207 (Claude Code)` → `2.1.207`; undefined when no semver is present. */
function parseVersion(stdout: string): string | undefined {
  return stdout.match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/)?.[1];
}

/**
 * Match a flag as a standalone token. Help text lists flags whitespace- or
 * comma-delimited (`-n, --name`), so a bare `includes` would false-positive
 * (`-n` inside `--session-id` need not, but `--settings` inside `--settings-x`
 * would). Bound the match on both sides.
 */
function helpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,('"\`])${escaped}([\\s,)='"\`]|$)`, 'm').test(help);
}

export async function detectClaude(options: DetectClaudeOptions = {}): Promise<ClaudeDetection> {
  const exec = options.exec ?? defaultExec;
  // Resolution order: explicit option → env override → PATH lookup of `claude`.
  const executable = options.executable ?? process.env.CHOPSTICKS_CLAUDE_BIN ?? 'claude';
  const warnings: string[] = [];

  let version: string | undefined;
  try {
    const { stdout } = await exec(executable, ['--version']);
    version = parseVersion(stdout);
    if (!version) warnings.push(`could not parse version from \`${executable} --version\`: ${stdout.trim()}`);
  } catch (err) {
    warnings.push(`\`${executable} --version\` failed: ${errMessage(err)}`);
  }

  let help = '';
  try {
    help = (await exec(executable, ['--help'])).stdout;
  } catch (err) {
    warnings.push(`\`${executable} --help\` failed: ${errMessage(err)}`);
  }

  const flags: ClaudeFlagSupport = {
    sessionId: helpHasFlag(help, '--session-id'),
    settings: helpHasFlag(help, '--settings'),
    name: helpHasFlag(help, '--name') || helpHasFlag(help, '-n'),
    permissionMode: helpHasFlag(help, '--permission-mode'),
  };

  const required: [keyof ClaudeFlagSupport, string][] = [
    ['sessionId', '--session-id'],
    ['settings', '--settings'],
    ['name', '--name/-n'],
    ['permissionMode', '--permission-mode'],
  ];
  for (const [key, label] of required) {
    if (!flags[key])
      warnings.push(`\`${executable} --help\` does not advertise ${label}; native driver capability degraded`);
  }

  return { executable, version, flags, warnings };
}
