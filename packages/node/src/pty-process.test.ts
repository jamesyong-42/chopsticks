import { describe, expect, it } from 'vitest';
import { fakeAgentBin } from '@vibecook/chopsticks-testing';
import { buildAgentEnvironment } from './env.js';
import { spawnPty, type NativeProcessHandle } from './pty.js';
import { classifyExit, killProcessGroup, terminateTree } from './process-tree.js';

function startFakeAgent() {
  const handle = spawnPty({
    command: process.execPath,
    args: [fakeAgentBin],
    cwd: process.cwd(),
    env: buildAgentEnvironment(),
  });
  let output = Buffer.alloc(0);
  const waiters: Array<{ test: () => boolean; resolve: () => void }> = [];
  handle.onData((data) => {
    output = Buffer.concat([output, Buffer.from(data)]);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].test()) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  });
  const waitFor = (predicate: (out: Buffer) => boolean, label: string, timeoutMs = 8000): Promise<void> => {
    if (predicate(output)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${label}; output:\n${output.toString('utf8')}`)),
        timeoutMs,
      );
      waiters.push({
        test: () => predicate(output),
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  };
  const waitForText = (text: string) => waitFor((out) => out.toString('utf8').includes(text), JSON.stringify(text));
  return { handle, waitForText, waitFor, getOutput: () => output };
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('spawnPty', () => {
  it('runs the fake agent over a real PTY: prompt roundtrip, resize, clean exit', async () => {
    const { handle, waitForText } = startFakeAgent();
    await waitForText('ready');
    handle.resize(100, 30);
    handle.write('hello\r');
    await waitForText('echo: hello');
    handle.write('/exit\r');
    const exit = await handle.exited;
    expect(exit.exitCode).toBe(0);
    expect(classifyExit({ exit })).toBe('completed');
  });

  it('preserves raw bytes, including malformed UTF-8 (ADR-004)', async () => {
    const { handle, waitFor, waitForText, getOutput } = startFakeAgent();
    await waitForText('ready');
    handle.write('/badutf8\r');
    await waitFor((out) => out.includes(Buffer.from([0xff, 0xfe, 0x80, 0x81])), 'raw 0xff 0xfe 0x80 0x81');
    expect(getOutput().includes(Buffer.from([0xff, 0xfe, 0x80, 0x81]))).toBe(true);
    handle.write('/exit\r');
    await handle.exited;
  });
});

describe('terminateTree', () => {
  it('escalates past an agent that ignores SIGINT and leaves no process behind', async () => {
    const { handle, waitForText } = startFakeAgent();
    await waitForText('ready');
    handle.write('/hang\r');
    await waitForText('hanging');
    const exit = await terminateTree(handle, { ctrlCGraceMs: 250, terminateGraceMs: 1500, killTreeAfterMs: 1500 });
    expect(exit.signal ?? exit.exitCode).not.toBeNull();
    expect(processGone(handle.pid)).toBe(true);
    expect(classifyExit({ exit, requestedBy: 'runtime' })).toBe('runtime-terminated');
  }, 15000);

  it('sweeps spawned descendants via the process group', async () => {
    const { handle, waitForText, getOutput } = startFakeAgent();
    await waitForText('ready');
    handle.write('/spawn\r');
    await waitForText('spawned sleep pid=');
    const match = /spawned sleep pid=(\d+)/.exec(getOutput().toString('utf8'));
    expect(match).not.toBeNull();
    const sleepPid = Number(match![1]);
    await terminateTree(handle, { ctrlCGraceMs: 250, terminateGraceMs: 1500, killTreeAfterMs: 1500 });
    // Group sweep must have taken the orphan with it.
    expect(processGone(sleepPid)).toBe(true);
  }, 15000);
});

describe('classifyExit', () => {
  it('maps exits per DESIGN §21.4', () => {
    expect(classifyExit({ exit: { exitCode: 0, signal: null } })).toBe('completed');
    expect(classifyExit({ exit: { exitCode: 1, signal: null } })).toBe('crash');
    expect(classifyExit({ exit: { exitCode: null, signal: 15 } })).toBe('signal');
    expect(classifyExit({ exit: null })).toBe('unknown');
    expect(classifyExit({ exit: { exitCode: 0, signal: null }, requestedBy: 'user' })).toBe('user-terminated');
    expect(classifyExit({ exit: null, spawnFailed: true })).toBe('spawn-failed');
  });
});

describe('killProcessGroup', () => {
  it('returns false for a group that no longer exists', () => {
    expect(killProcessGroup(999999901)).toBe(false);
  });
});
