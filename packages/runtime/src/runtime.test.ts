import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  async automateTerminal() {
    return { accepted: true };
  },
};

const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.useRealTimers();
});

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
  handles: Map<string, { emit: (event: AgentEventEnvelope) => void }>,
): AgentProvider {
  let counter = 0;
  return {
    kind,
    async createSession(): Promise<AgentSession> {
      const n = ++counter;
      const runtimeSessionId = `${kind}-runtime-${n}`;
      const listeners = new Set<(event: AgentEventEnvelope) => void>();
      handles.set(runtimeSessionId, {
        emit: (event) => listeners.forEach((listener) => listener(event)),
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
        async dispose() {},
      };
    },
  };
}

function preparableProvider(
  kind: string,
  hooks: {
    prepareCount: number;
    adoptCount: number;
    disposeCount: number;
    preparedCwd?: string;
    adoptionGate?: Promise<void>;
  },
): AgentProvider {
  const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
  const managed = fakeProvider(kind, handles);
  return {
    ...managed,
    async prepareSession(options) {
      hooks.prepareCount += 1;
      hooks.preparedCwd = options.cwd;
      const sessionId = `${kind}-prepared-${hooks.prepareCount}`;
      let disposed = false;
      let adopted: AgentSession | undefined;
      return {
        sessionId,
        launch: {
          command: `/opt/${kind}`,
          args: ['--session-id', sessionId],
          cwd: options.cwd,
          env: { PREPARED_TOKEN: 'secret' },
        },
        async adopt(runtimeSessionId) {
          hooks.adoptCount += 1;
          await hooks.adoptionGate;
          if (adopted) return adopted;
          const listeners = new Set<(event: AgentEventEnvelope) => void>();
          adopted = {
            sessionId,
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
            async dispose() {
              if (disposed) return;
              disposed = true;
              hooks.disposeCount += 1;
            },
          };
          return adopted;
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          hooks.disposeCount += 1;
        },
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
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
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

    handles.get(first.runtimeSessionId)!.emit({
      sequence: 3,
      sessionId: first.sessionId,
      turnId: 'one-turn',
      timestamp: new Date().toISOString(),
      monotonicTime: 3,
      source: 'native-hook',
      confidence: 'authoritative',
      event: { type: 'turn.started', turnId: 'one-turn', prompt: 'hello' },
    });
    handles.get(first.runtimeSessionId)!.emit({
      sequence: 4,
      sessionId: first.sessionId,
      turnId: 'one-turn',
      timestamp: new Date().toISOString(),
      monotonicTime: 4,
      source: 'native-hook',
      confidence: 'authoritative',
      event: { type: 'assistant.message', messageId: 'm1', text: '**hi**', final: false },
    });
    expect(runtime.conversationSnapshot(first.runtimeSessionId)).toMatchObject({
      responding: true,
      items: [
        { kind: 'user', text: 'hello' },
        { kind: 'assistant', markdown: '**hi**', streaming: true },
      ],
    });

    expect(await runtime.submitPrompt(second.runtimeSessionId, { text: 'hello' })).toEqual({
      status: 'confirmed',
      turnId: 'two-turn',
    });
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
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
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

  it('passes provider-owned launch options through without interpreting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-options-'));
    let received: unknown;
    const provider: AgentProvider = {
      kind: 'one',
      async createSession(options) {
        received = options.agentOptions;
        return fakeProvider('one', new Map()).createSession(options);
      },
    };
    const runtime = createAgentRuntime({ host, defaultCwd: root, providers: [provider] });

    const result = await runtime.createSession({
      agent: 'one',
      agentOptions: { futureProviderFlag: true },
    });

    expect('error' in result).toBe(false);
    expect(received).toEqual({ futureProviderFlag: true });
    await runtime.dispose();
  });

  it('prepares without spawning, binds before exec, and adopts the same pane idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-prepare-'));
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [preparableProvider('one', hooks)],
    });

    const prepared = await runtime.prepareSession({ agent: 'one' });
    expect('error' in prepared).toBe(false);
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    expect(prepared).toMatchObject({
      agent: 'one',
      sessionId: 'one-prepared-1',
      launch: {
        command: '/opt/one',
        args: ['--session-id', 'one-prepared-1'],
        cwd: prepared.workspace.root,
        env: { PREPARED_TOKEN: 'secret' },
      },
    });
    expect(runtime.sessionInfo('existing-pane')).toBeUndefined();

    const first = await runtime.adoptPrepared(prepared.preparationId, {
      runtimeSessionId: 'existing-pane',
      processId: 4242,
    });
    expect(first).toMatchObject({
      agent: 'one',
      sessionId: prepared.sessionId,
      runtimeSessionId: 'existing-pane',
      preparationId: prepared.preparationId,
      processId: 4242,
    });
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'existing-pane' })).toEqual(first);
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'other-pane' })).toMatchObject({
      error: { code: 'PREPARATION_ALREADY_ADOPTED' },
    });
    expect(hooks.adoptCount).toBe(1);
    expect(await runtime.submitPrompt('existing-pane', { text: 'hello' })).toMatchObject({ status: 'confirmed' });

    await runtime.handleProcessExit('existing-pane', { exitCode: 0, signal: null, reason: 'completed' });
    expect(runtime.sessionInfo('existing-pane')).toBeUndefined();
    expect(hooks.disposeCount).toBe(1);
    await runtime.dispose();
  });

  it('reports unsupported providers and terminal conflicts without consuming the preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-unsupported-'));
    const handles = new Map<string, { emit: (event: AgentEventEnvelope) => void }>();
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [fakeProvider('plain', handles), preparableProvider('prepared', hooks)],
    });

    expect(await runtime.prepareSession({ agent: 'plain' })).toMatchObject({
      error: { code: 'PREPARATION_UNSUPPORTED' },
    });
    const existing = await runtime.createSession({ agent: 'plain' });
    if ('error' in existing) throw new Error('unexpected create failure');
    const prepared = await runtime.prepareSession({ agent: 'prepared' });
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    expect(
      await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: existing.runtimeSessionId }),
    ).toMatchObject({ error: { code: 'RUNTIME_SESSION_CONFLICT' } });
    expect(hooks.adoptCount).toBe(0);
    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    await runtime.dispose();
  });

  it('expires unused preparations, cleans their copy workspace, and returns a typed error', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-expiry-'));
    await writeFile(join(root, 'file.txt'), 'source');
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-expiry-copies-'));
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0 };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      preparationTtlMs: 25,
      providers: [preparableProvider('one', hooks)],
    });

    const prepared = await runtime.prepareSession({
      agent: 'one',
      workspace: { mode: 'copy', workspacesRoot },
    });
    if ('error' in prepared) throw new Error('unexpected prepare failure');
    const preparedRoot = prepared.workspace.root;
    expect(existsSync(preparedRoot)).toBe(true);

    await vi.advanceTimersByTimeAsync(25);
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'late-pane' })).toMatchObject({
      error: { code: 'PREPARATION_EXPIRED' },
    });
    expect(existsSync(preparedRoot)).toBe(false);
    expect(hooks.disposeCount).toBe(1);
    await runtime.dispose();
  });

  it('linearizes concurrent adoption and lets the shim cancel after an exec failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-runtime-adopt-race-'));
    let releaseAdoption!: () => void;
    const adoptionGate = new Promise<void>((resolve) => (releaseAdoption = resolve));
    const hooks = { prepareCount: 0, adoptCount: 0, disposeCount: 0, adoptionGate };
    const runtime = createAgentRuntime({
      host,
      defaultCwd: root,
      providers: [preparableProvider('one', hooks)],
    });
    const prepared = await runtime.prepareSession({ agent: 'one' });
    if ('error' in prepared) throw new Error('unexpected prepare failure');

    const first = runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'pane' });
    const second = runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'pane' });
    expect(await runtime.adoptPrepared(prepared.preparationId, { runtimeSessionId: 'other-pane' })).toMatchObject({
      error: { code: 'PREPARATION_ALREADY_ADOPTED' },
    });
    releaseAdoption();
    expect(await second).toEqual(await first);
    expect(hooks.adoptCount).toBe(1);

    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    expect(runtime.sessionInfo('pane')).toBeUndefined();
    expect(await runtime.cancelPrepared(prepared.preparationId)).toEqual({ cancelled: true });
    expect(hooks.disposeCount).toBe(1);
    await runtime.dispose();
  });
});
