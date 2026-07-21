import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, type AgentHost } from '@vibecook/chopsticks-core';

const fakes = vi.hoisted(() => ({
  createObserver: vi.fn(),
  observerDispose: vi.fn(),
  serverDispose: vi.fn(),
  serverReady: vi.fn(),
  spawnServer: vi.fn(),
  transport: {},
}));

vi.mock('./observer.js', () => ({
  createCodexObserver: fakes.createObserver,
}));

vi.mock('./ws-transport.js', () => ({
  spawnAppServer: fakes.spawnServer,
  wsOverUnixTransport: vi.fn(() => fakes.transport),
}));

import { createCodexTuiSession, prepareCodexTuiSession } from './tui-session.js';

function host(): AgentHost {
  return {
    spawnTerminal: vi.fn(async () => ({ runtimeSessionId: 'spawned-pane' })),
    automateTerminal: vi.fn(async () => ({ accepted: true as const })),
  };
}

describe('Codex TUI preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.serverReady.mockResolvedValue(undefined);
    fakes.observerDispose.mockResolvedValue(undefined);
    fakes.spawnServer.mockReturnValue({
      socketPath: '/tmp/codex.sock',
      ready: fakes.serverReady,
      dispose: fakes.serverDispose,
    });
    fakes.createObserver.mockResolvedValue({
      sessionId: 'thread-1',
      state: createInitialSessionState,
      observationLevel: () => 'structured',
      threadPath: () => '/tmp/thread.jsonl',
      onEvent: () => () => undefined,
      dispose: fakes.observerDispose,
    });
  });

  it('owns the thread before launch and adopts one existing terminal idempotently', async () => {
    const terminalHost = host();
    const onApproval = vi.fn(() => 'approved' as const);
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: terminalHost,
      model: 'gpt-test',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      onApproval,
    });

    expect(terminalHost.spawnTerminal).not.toHaveBeenCalled();
    expect(prepared.sessionId).toBe('thread-1');
    expect(prepared.launch).toEqual({
      command: '/opt/codex',
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex.sock'],
      cwd: '/work/repo',
    });
    expect(fakes.createObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        start: expect.objectContaining({ model: 'gpt-test', sandbox: 'read-only', approvalPolicy: 'never' }),
        onApproval,
      }),
    );

    const first = await prepared.adopt('existing-pane');
    expect(first.runtimeSessionId).toBe('existing-pane');
    expect(await prepared.adopt('existing-pane')).toBe(first);
    await expect(prepared.adopt('other-pane')).rejects.toThrow('already adopted');

    await first.submitPrompt({ text: 'hello' });
    expect(terminalHost.automateTerminal).toHaveBeenCalledWith('existing-pane', {
      kind: 'paste',
      text: 'hello',
      submit: true,
    });
    await prepared.dispose();
    expect(fakes.observerDispose).toHaveBeenCalledOnce();
    expect(fakes.serverDispose).toHaveBeenCalledOnce();
  });

  it('preserves the managed createSession spawn path through the same preparation', async () => {
    const terminalHost = host();
    const session = await createCodexTuiSession({ cwd: '/work/repo', host: terminalHost });

    expect(terminalHost.spawnTerminal).toHaveBeenCalledWith({
      command: 'codex',
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex.sock'],
      cwd: '/work/repo',
    });
    expect(session.runtimeSessionId).toBe('spawned-pane');
    await session.dispose();
  });
});
