import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, type AgentHost, type AgentSession } from '@vibecook/chopsticks-core';
import type { AcpConnector } from '@vibecook/chopsticks-adapter-acp';

const adapters = vi.hoisted(() => ({
  createAcpSession: vi.fn(),
  createClaudeSession: vi.fn(),
  createCodexTuiSession: vi.fn(),
  createGrokBackend: vi.fn(),
}));

vi.mock('@vibecook/chopsticks-adapter-acp', () => ({
  createAcpSession: adapters.createAcpSession,
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
    adapters.createAcpSession.mockResolvedValue(fakeSession('acp'));
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
