/**
 * Native Claude session preparation (DESIGN §16.2 steps 4–5, 8; §11
 * PreparedNativeSession). Allocates the runtime session UUID — the
 * chopsticks ↔ spaghetti join contract (§2.1, §14.4): the same UUID keys the
 * transcript on disk and Spaghetti's index — writes the generated hook
 * settings to a per-session file, and builds the interactive spawn command.
 *
 * The command is native-interactive ONLY (§16.3): never -p/--print/
 * --output-format/--input-format — those select structured print mode, a
 * different process class. The token VALUE rides `env` (injected into the
 * process, resolved by Claude's env interpolation), never the on-disk settings.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHookSettings } from './settings.js';

export interface PrepareClaudeSessionOptions {
  cwd: string;
  title?: string;
  /** Reuse a caller-chosen session UUID; otherwise one is generated. */
  sessionId?: string;
  endpoint: string;
  tokenEnvVar: string;
  /** The bearer token VALUE — placed in `env`, never written to disk. */
  token: string;
  executable?: string;
  permissionMode?: string;
  /**
   * Resume an existing session by its id instead of starting fresh. Probed
   * (HOOK-SURFACE-FINDINGS §6): `--resume <id>` continues the SAME session and
   * transcript in place, so the id/join-contract is preserved automatically —
   * `--session-id` is NOT passed alongside it. When set, `sessionId` is
   * ignored in favor of this id.
   */
  resume?: string;
  /** Override the settings-file directory (tests); default is an mkdtemp dir. */
  settingsDir?: string;
}

/** DESIGN §11 PreparedNativeSession, narrowed to what this adapter fills. */
export interface PreparedClaudeSession {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  settingsPath: string;
  filesToCleanup: string[];
}

export async function prepareClaudeSession(options: PrepareClaudeSessionOptions): Promise<PreparedClaudeSession> {
  // On resume the session keeps its own id + transcript, so that id IS the
  // session id; otherwise reuse a caller-chosen id or mint one.
  const sessionId = options.resume ?? options.sessionId ?? randomUUID();
  const settings = generateHookSettings({ endpoint: options.endpoint, tokenEnvVar: options.tokenEnvVar });

  // Own the temp dir only when we create it; a caller-supplied settingsDir is
  // the caller's to clean, so it stays out of filesToCleanup (§23: no
  // destroying state we didn't create).
  const ownsDir = options.settingsDir === undefined;
  const dir = options.settingsDir ?? (await mkdtemp(join(tmpdir(), 'chopsticks-claude-')));
  const settingsPath = join(dir, `${sessionId}.settings.json`);
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  // --resume and --session-id are mutually exclusive: resume continues an
  // existing id, so passing --session-id would fight it. --settings composes
  // with both (the hook bridge attaches to resumed sessions too — probed §6).
  const args = options.resume ? ['--resume', sessionId] : ['--session-id', sessionId];
  if (options.title !== undefined) args.push('--name', options.title);
  args.push('--settings', settingsPath, '--permission-mode', options.permissionMode ?? 'default');

  return {
    sessionId,
    command: options.executable ?? 'claude',
    args,
    cwd: options.cwd,
    env: { [options.tokenEnvVar]: options.token },
    settingsPath,
    filesToCleanup: ownsDir ? [settingsPath, dir] : [settingsPath],
  };
}

/** Remove the session's generated files; tolerant of already-gone paths. */
export async function cleanupClaudeSession(prepared: PreparedClaudeSession): Promise<void> {
  for (const path of prepared.filesToCleanup) {
    await rm(path, { recursive: true, force: true });
  }
}
