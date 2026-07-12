/**
 * Process-tree control (DESIGN §21).
 *
 * POSIX: node-pty's child is the session leader of its own process group, so
 * signaling -pid reaches the whole owned tree (shells, test runners, MCP
 * servers). Escalation ladder per §21.2; the group is always swept at the end
 * so no rung leaves orphans behind. Windows Job Objects are out of scope for
 * v0.1 (IMPLEMENTATION-PLAN §2).
 */

import type { ProcessExitReason } from '@vibecook/chopsticks-core';
import type { NativeProcessHandle, ProcessExit } from './pty.js';

export interface InterruptPolicy {
  ctrlCGraceMs: number;
  terminateGraceMs: number;
  killTreeAfterMs: number;
}

export const DEFAULT_INTERRUPT_POLICY: InterruptPolicy = {
  ctrlCGraceMs: 2000,
  terminateGraceMs: 2000,
  killTreeAfterMs: 2000,
};

/** DESIGN §21.4 — a zero exit code is not a semantic success signal. */
export function classifyExit(input: {
  exit: ProcessExit | null;
  requestedBy?: 'user' | 'runtime' | null;
  spawnFailed?: boolean;
}): ProcessExitReason {
  if (input.spawnFailed) return 'spawn-failed';
  if (input.requestedBy === 'user') return 'user-terminated';
  if (input.requestedBy === 'runtime') return 'runtime-terminated';
  const exit = input.exit;
  if (!exit || exit.exitCode === null) return exit?.signal ? 'signal' : 'unknown';
  if (exit.signal) return 'signal';
  return exit.exitCode === 0 ? 'completed' : 'crash';
}

/** Signal the whole process group. Returns false when it is already gone. */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function raceExit(exited: Promise<ProcessExit>, ms: number): Promise<ProcessExit | null> {
  return Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Escalation ladder (§21.2): Ctrl-C → SIGTERM → SIGKILL to the group.
 * Resolves with the observed exit; the group is swept regardless of which
 * rung ended the leader.
 */
export async function terminateTree(
  handle: NativeProcessHandle,
  policy: InterruptPolicy = DEFAULT_INTERRUPT_POLICY,
): Promise<ProcessExit> {
  handle.write('\x03');
  let exit = await raceExit(handle.exited, policy.ctrlCGraceMs);
  if (!exit) {
    handle.kill('SIGTERM');
    exit = await raceExit(handle.exited, policy.terminateGraceMs);
  }
  if (!exit) {
    killProcessGroup(handle.pid, 'SIGKILL');
    exit = await raceExit(handle.exited, policy.killTreeAfterMs);
  }
  killProcessGroup(handle.pid, 'SIGKILL');
  return exit ?? { exitCode: null, signal: null };
}
