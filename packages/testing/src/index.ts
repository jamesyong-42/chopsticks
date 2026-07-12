/**
 * @vibecook/chopsticks-testing — harness pieces for runtime and adapter tests.
 *
 * - `fakeAgentBin`: a spawnable fixture TUI (DESIGN §26.1); see bin/fake-agent.mjs
 * - hook fixtures: real Claude Code payloads captured by the Phase 0 probe
 * - `fakeClaudeHookPayload`: synthetic Claude-shaped payloads for bridge tests
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path to the fake agent executable; spawn with process.execPath. */
export const fakeAgentBin = join(packageRoot, 'bin', 'fake-agent.mjs');

/** Directory of captured hook payload fixtures (one JSONL file per event). */
export const hookFixturesDir = join(packageRoot, 'fixtures', 'hooks');

/**
 * Common envelope observed on every Claude Code hook payload
 * (draft/HOOK-SURFACE-FINDINGS.md §2).
 */
export interface CapturedHookRecord {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  [key: string]: unknown;
}

/** Event names with captured fixtures available. */
export function listHookFixtureEvents(): string[] {
  return readdirSync(hookFixturesDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .sort();
}

function parseJsonl(path: string): CapturedHookRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedHookRecord);
}

/** Load captured payloads, optionally for a single event name. */
export function loadHookFixtures(event?: string): CapturedHookRecord[] {
  const events = event ? [event] : listHookFixtureEvents();
  return events.flatMap((e) => parseJsonl(join(hookFixturesDir, `${e}.jsonl`)));
}

/**
 * Build a synthetic Claude-shaped hook payload. Useful where fixtures don't
 * cover an event (e.g. PermissionRequest, which never fires headless) or where
 * bridge tests need duplicates / out-of-order variants of one payload.
 */
export function fakeClaudeHookPayload(event: string, overrides: Record<string, unknown> = {}): CapturedHookRecord {
  const sessionId = (overrides.session_id as string) ?? '00000000-0000-4000-8000-000000000000';
  return {
    session_id: sessionId,
    transcript_path: `/tmp/fake-agent/${sessionId}.jsonl`,
    cwd: '/tmp/fake-agent',
    hook_event_name: event,
    ...overrides,
  };
}
