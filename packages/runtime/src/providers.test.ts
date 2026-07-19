import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, type AgentHost, type AgentSession } from '@vibecook/chopsticks-core';

const adapters = vi.hoisted(() => ({
  createClaudeSession: vi.fn(),
  createCodexTuiSession: vi.fn(),
  createGrokBackend: vi.fn(),
}));

vi.mock('@vibecook/chopsticks-adapter-claude', () => ({
  createClaudeSession: adapters.createClaudeSession,
}));

vi.mock('@vibecook/chopsticks-adapter-codex', () => ({
  createCodexTuiSession: adapters.createCodexTuiSession,
}));

vi.mock('@vibecook/chopsticks-adapter-grok', () => ({
  createGrokBackend: adapters.createGrokBackend,
}));

import { createBuiltinProviders } from './providers.js';
import type { BuiltinCreateAgentSessionOptions } from './types.js';

const host: AgentHost = {
  async spawnTerminal() {
    return { runtimeSessionId: 'runtime-1' };
  },
  async automateTerminal() {
    return { accepted: true };
  },
};

function fakeSession(kind: string): AgentSession {
  return {
    sessionId: `${kind}-session`,
    runtimeSessionId: `${kind}-runtime`,
    state: createInitialSessionState,
    observationLevel: () => 'structured',
    onEvent: () => () => undefined,
    async submitPrompt() {
      return { status: 'confirmed' };
    },
    async dispose() {},
  };
}

describe('createBuiltinProviders launch options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapters.createClaudeSession.mockResolvedValue(fakeSession('claude'));
    adapters.createCodexTuiSession.mockResolvedValue(fakeSession('codex'));
    adapters.createGrokBackend.mockReturnValue({ createSession: vi.fn(), dispose: vi.fn() });
  });

  it('forwards Claude model and permission mode to the native driver', async () => {
    const claude = createBuiltinProviders({ executables: { claude: '/opt/claude' } }).find(
      (provider) => provider.kind === 'claude',
    )!;

    await claude.createSession({
      cwd: '/work/repo',
      title: 'review',
      host,
      agentOptions: { model: 'claude-fable-5', permissionMode: 'plan' },
    });

    expect(adapters.createClaudeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        title: 'review',
        executable: '/opt/claude',
        model: 'claude-fable-5',
        permissionMode: 'plan',
      }),
    );
  });

  it('forwards Codex safety posture to the native-TUI thread bootstrap', async () => {
    const codex = createBuiltinProviders({ executables: { codex: '/opt/codex' } }).find(
      (provider) => provider.kind === 'codex',
    )!;

    await codex.createSession({
      cwd: '/work/repo',
      host,
      agentOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    });

    expect(adapters.createCodexTuiSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: undefined,
      executable: '/opt/codex',
      host,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
  });
});

const typedClaudeRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'claude',
  agentOptions: { model: 'sonnet', permissionMode: 'plan' },
};
void typedClaudeRequest;

const mismatchedRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'claude',
  // @ts-expect-error a Codex sandbox is not a Claude launch option
  agentOptions: { sandbox: 'read-only' },
};
void mismatchedRequest;
