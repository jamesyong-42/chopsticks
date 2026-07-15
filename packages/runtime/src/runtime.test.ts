import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createInitialSessionState,
  type AgentEventEnvelope,
  type AgentHost,
  type AgentSession,
} from '@vibecook/chopsticks-core';
import { createActionRecorder } from '@vibecook/chopsticks-record';
import { createAgentRuntime } from './runtime.js';
import type { AgentProvider } from './types.js';

const host: AgentHost = {
  async spawnTerminal() {
    throw new Error('fake providers do not spawn');
  },
  writeTerminal() {},
};

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-repo-'));
  const run = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
  await run('init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await run('add', '.');
  await run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return repo;
}

function fakeProvider(
  kind: string,
  handles: Map<string, { emit: (event: AgentEventEnvelope) => void; input: number[] }>,
): AgentProvider {
  let counter = 0;
  return {
    kind,
    async createSession(): Promise<AgentSession> {
      const n = ++counter;
      const runtimeSessionId = `${kind}-runtime-${n}`;
      const listeners = new Set<(event: AgentEventEnvelope) => void>();
      const input: number[] = [];
      handles.set(runtimeSessionId, {
        emit: (event) => listeners.forEach((listener) => listener(event)),
        input,
      });
      return {
        sessionId: `${kind}-native-${n}`,
        runtimeSessionId,
        state: createInitialSessionState,
        observationLevel: () => 'structured',
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async submitPrompt() {
          return { status: 'confirmed', turnId: `${kind}-turn` };
        },
        notifyUserInput() {
          input.push(1);
        },
        async dispose() {},
      };
    },
  };
}

describe('createAgentRuntime', () => {
  it('drives different providers through one create/observe/control/exit surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-'));
    const one = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-one-'));
    const two = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-two-'));
    const recorder = createActionRecorder({ path: join(root, 'actions.jsonl') });
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void; input: number[] }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      recorder,
      providers: [fakeProvider('one', handles), fakeProvider('two', handles)],
    });

    const first = await runtime.createSession({ agent: 'one', cwd: one });
    const second = await runtime.createSession({ agent: 'two', cwd: two });
    expect('error' in first).toBe(false);
    expect('error' in second).toBe(false);
    if ('error' in first || 'error' in second) throw new Error('unexpected create failure');
    expect(first).toMatchObject({ agent: 'one', sessionId: 'one-native-1', runtimeSessionId: 'one-runtime-1' });
    expect(second).toMatchObject({ agent: 'two', sessionId: 'two-native-1', runtimeSessionId: 'two-runtime-1' });

    const observed: string[] = [];
    runtime.onEvent((id, envelope) => observed.push(`${id}:${envelope.event.type}`));
    handles.get(first.runtimeSessionId)!.emit({
      sequence: 1,
      sessionId: first.sessionId,
      timestamp: new Date().toISOString(),
      monotonicTime: 1,
      source: 'runtime',
      confidence: 'authoritative',
      event: { type: 'session.ready' },
    });
    expect(observed).toEqual(['one-runtime-1:session.ready']);
    handles.get(first.runtimeSessionId)!.emit({
      sequence: 2,
      sessionId: first.sessionId,
      timestamp: new Date().toISOString(),
      monotonicTime: 2,
      source: 'native-transcript',
      confidence: 'authoritative',
      event: { type: 'assistant.message', text: 'duplicate transcript copy' },
    });
    expect(observed).toEqual(['one-runtime-1:session.ready']);

    expect(await runtime.submitPrompt(second.runtimeSessionId, { text: 'hello' })).toEqual({
      status: 'confirmed',
      turnId: 'two-turn',
    });
    runtime.notifyUserInput(second.runtimeSessionId);
    expect(handles.get(second.runtimeSessionId)!.input).toHaveLength(1);

    const final = await runtime.handleProcessExit(second.runtimeSessionId, {
      exitCode: 0,
      signal: null,
      reason: 'completed',
    });
    expect(final?.runtimeSessionId).toBe(second.runtimeSessionId);
    expect(runtime.sessionInfo(second.runtimeSessionId)).toBeUndefined();
    expect((await recorder.read()).map((action) => action.type)).toEqual([
      'injection',
      'session-exit',
      'workspace-final',
    ]);

    await runtime.dispose();
  });

  it('allows direct concurrency and enforces exclusive claims independently of provider', async () => {
    const root = await makeRepo();
    const roots = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-worktrees-'));
    const nested = join(root, 'nested');
    await mkdir(nested);
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void; input: number[] }>();
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('one', handles), fakeProvider('two', handles)],
    });

    const directOne = await runtime.createSession({ agent: 'one' });
    const directTwo = await runtime.createSession({ agent: 'two', workspace: { mode: 'direct', path: nested } });
    expect('error' in directOne).toBe(false);
    expect('error' in directTwo).toBe(false);
    expect(await runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });

    if ('error' in directOne || 'error' in directTwo) throw new Error('unexpected create failure');
    await runtime.handleProcessExit(directOne.runtimeSessionId, { exitCode: 0, signal: null, reason: 'completed' });
    expect(await runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    await runtime.handleProcessExit(directTwo.runtimeSessionId, { exitCode: 0, signal: null, reason: 'completed' });

    const exclusive = await runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } });
    expect('error' in exclusive).toBe(false);
    expect(await runtime.createSession({ agent: 'two' })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    expect(await runtime.createSession({ agent: 'two', workspace: { mode: 'exclusive' } })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    expect(
      'error' in
        (await runtime.createSession({
          agent: 'two',
          workspace: { mode: 'worktree', workspacesRoot: roots },
        })),
    ).toBe(false);
    expect(await runtime.createSession({ agent: 'missing' })).toEqual({
      error: { code: 'AGENT_NOT_FOUND', message: 'unknown agent provider: missing' },
    });

    await runtime.dispose();
  }, 20_000);

  it('reserves an exclusive claim before asynchronous provider creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-atomic-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void; input: number[] }>();
    const inner = fakeProvider('one', handles);
    let signalStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
    const provider: AgentProvider = {
      ...inner,
      async createSession(options) {
        signalStarted();
        await providerGate;
        return inner.createSession(options);
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });

    const firstPending = runtime.createSession({ agent: 'one', workspace: { mode: 'exclusive' } });
    await started;
    expect(await runtime.createSession({ agent: 'one' })).toMatchObject({
      error: { code: 'WORKSPACE_CONFLICT' },
    });
    releaseProvider();
    expect('error' in (await firstPending)).toBe(false);

    await runtime.dispose();
  });
});
