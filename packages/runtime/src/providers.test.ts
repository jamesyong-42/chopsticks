import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, type AgentHost, type AgentSession } from '@vibecook/chopsticks-core';
import type { AcpConnector } from '@vibecook/chopsticks-adapter-acp';

const adapters = vi.hoisted(() => ({
  createAcpSession: vi.fn(),
  createClaudeSession: vi.fn(),
  prepareClaudeTuiSession: vi.fn(),
  createCodexTuiSession: vi.fn(),
  prepareCodexTuiSession: vi.fn(),
  createGrokBackend: vi.fn(),
}));

vi.mock('@vibecook/chopsticks-adapter-acp', () => ({
  createAcpSession: adapters.createAcpSession,
}));

vi.mock('@vibecook/chopsticks-adapter-claude', () => ({
  createClaudeSession: adapters.createClaudeSession,
  prepareClaudeTuiSession: adapters.prepareClaudeTuiSession,
}));

vi.mock('@vibecook/chopsticks-adapter-codex', () => ({
  createCodexTuiSession: adapters.createCodexTuiSession,
  prepareCodexTuiSession: adapters.prepareCodexTuiSession,
}));

vi.mock('@vibecook/chopsticks-adapter-grok', () => ({
  createGrokBackend: adapters.createGrokBackend,
}));

import { createBuiltinProviders } from './providers.js';
import type { BuiltinAgentRuntime, BuiltinCreateAgentSessionOptions } from './types.js';

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

function fakePreparation(kind: string) {
  return {
    sessionId: `${kind}-session`,
    launch: {
      command: `/opt/${kind}`,
      args: ['--prepared'],
      cwd: '/work/repo',
      env: { SECRET: 'value' },
      settingsPath: '/private/internal',
      filesToCleanup: ['/private/internal'],
    },
    adopt: vi.fn(async (runtimeSessionId: string) => ({ ...fakeSession(kind), runtimeSessionId })),
    dispose: vi.fn(),
  };
}

describe('createBuiltinProviders launch options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapters.createAcpSession.mockResolvedValue(fakeSession('acp'));
    adapters.createClaudeSession.mockResolvedValue(fakeSession('claude'));
    adapters.prepareClaudeTuiSession.mockResolvedValue(fakePreparation('claude'));
    adapters.createCodexTuiSession.mockResolvedValue(fakeSession('codex'));
    adapters.prepareCodexTuiSession.mockResolvedValue(fakePreparation('codex'));
    adapters.createGrokBackend.mockReturnValue({
      createSession: vi.fn(),
      prepareSession: vi.fn(async () => fakePreparation('grok')),
      dispose: vi.fn(),
    });
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

    const onApproval = vi.fn(() => 'approved' as const);
    await codex.createSession({
      cwd: '/work/repo',
      host,
      agentOptions: { model: 'gpt-5.6-sol', sandbox: 'read-only', approvalPolicy: 'never', onApproval },
    });

    expect(adapters.createCodexTuiSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: undefined,
      executable: '/opt/codex',
      host,
      model: 'gpt-5.6-sol',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      onApproval,
    });
  });

  it('forwards generic ACP capabilities and approvals through a configured connector', async () => {
    const connector = vi.fn() as unknown as AcpConnector;
    const onApproval = vi.fn(() => 'approved' as const);
    const clientCapabilities = { terminal: true };
    const acp = createBuiltinProviders({ acpConnector: connector }).find((provider) => provider.kind === 'acp')!;

    await acp.createSession({
      cwd: '/work/repo',
      resume: 'session-1',
      host,
      agentOptions: { clientCapabilities, onApproval },
    });

    expect(adapters.createAcpSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: 'session-1',
      connector,
      clientCapabilities,
      onApproval,
    });
  });

  it('forwards Grok model, safety posture, capabilities, and approvals', async () => {
    const onApproval = vi.fn(() => 'denied' as const);
    const clientCapabilities = { terminal: true };
    const providers = createBuiltinProviders({ executables: { grok: '/opt/grok' } });
    const grok = providers.find((provider) => provider.kind === 'grok')!;

    await grok.createSession({
      cwd: '/work/repo',
      host,
      agentOptions: {
        model: 'grok-code-fast',
        permissionMode: 'plan',
        sandbox: 'workspace-write',
        clientCapabilities,
        onApproval,
      },
    });

    expect(adapters.createGrokBackend).toHaveBeenCalledWith({ executable: '/opt/grok', host });
    const backend = adapters.createGrokBackend.mock.results[0]!.value;
    expect(backend.createSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: undefined,
      model: 'grok-code-fast',
      permissionMode: 'plan',
      sandbox: 'workspace-write',
      clientCapabilities,
      onApproval,
    });
  });

  it('exposes prepare/adopt for native providers while generic ACP stays explicitly unsupported', async () => {
    const providers = createBuiltinProviders({
      executables: { claude: '/opt/claude', codex: '/opt/codex', grok: '/opt/grok' },
    });
    const claude = providers.find((provider) => provider.kind === 'claude')!;
    const codex = providers.find((provider) => provider.kind === 'codex')!;
    const acp = providers.find((provider) => provider.kind === 'acp')!;
    const grok = providers.find((provider) => provider.kind === 'grok')!;

    const claudePrepared = await claude.prepareSession!({
      cwd: '/work/repo',
      title: 'review',
      host,
      agentOptions: { model: 'sonnet', permissionMode: 'plan' },
    });
    expect(adapters.prepareClaudeTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        title: 'review',
        executable: '/opt/claude',
        model: 'sonnet',
        permissionMode: 'plan',
      }),
    );
    expect(claudePrepared.launch).toEqual({
      command: '/opt/claude',
      args: ['--prepared'],
      cwd: '/work/repo',
      env: { SECRET: 'value' },
    });

    await codex.prepareSession!({ cwd: '/work/repo', host, agentOptions: { sandbox: 'read-only' } });
    expect(adapters.prepareCodexTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/repo', executable: '/opt/codex', sandbox: 'read-only', host }),
    );

    const onApproval = vi.fn(() => 'approved' as const);
    await grok.prepareSession!({
      cwd: '/work/repo',
      host,
      agentOptions: { permissionMode: 'plan', onApproval },
    });
    const backend = adapters.createGrokBackend.mock.results[0]!.value;
    expect(backend.prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/repo', permissionMode: 'plan', onApproval }),
    );
    expect(acp.prepareSession).toBeUndefined();
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

const typedConnector = vi.fn() as unknown as AcpConnector;
const typedAcpRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'acp',
  agentOptions: { connector: typedConnector, clientCapabilities: { terminal: true }, onApproval: () => 'approved' },
};
void typedAcpRequest;

const typedGrokRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'grok',
  agentOptions: { model: 'grok-code-fast', permissionMode: 'plan', sandbox: 'workspace-write' },
};
void typedGrokRequest;

type BuiltinPrepareRequest = Parameters<BuiltinAgentRuntime['prepareSession']>[0];
const typedCodexPreparation: BuiltinPrepareRequest = {
  agent: 'codex',
  agentOptions: { model: 'gpt-5.6-sol', sandbox: 'read-only', onApproval: () => 'denied' },
};
void typedCodexPreparation;

const mismatchedPreparation: BuiltinPrepareRequest = {
  agent: 'grok',
  // @ts-expect-error a Codex approvalPolicy is not a Grok launch option
  agentOptions: { approvalPolicy: 'never' },
};
void mismatchedPreparation;
