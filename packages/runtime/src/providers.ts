import { createAcpSession, type AcpConnector } from '@vibecook/chopsticks-adapter-acp';
import { createClaudeSession } from '@vibecook/chopsticks-adapter-claude';
import { createCodexTuiSession } from '@vibecook/chopsticks-adapter-codex';
import { createGrokBackend, type GrokBackend } from '@vibecook/chopsticks-adapter-grok';
import type {
  AcpAgentOptions,
  AgentProvider,
  BuiltinExecutableAgentKind,
  ClaudeAgentOptions,
  CodexAgentOptions,
  GrokAgentOptions,
} from './types.js';

export interface BuiltinProviderOptions {
  executables?: Partial<Record<BuiltinExecutableAgentKind, string>>;
  /** Default connector for generic ACP sessions; individual sessions may override it. */
  acpConnector?: AcpConnector;
}

/**
 * Construct the built-in providers. All CLI-specific recipes and shared service
 * lifetimes terminate here; callers only see AgentProvider/AgentRuntime.
 */
export function createBuiltinProviders(options: BuiltinProviderOptions = {}): AgentProvider[] {
  const { executables = {}, acpConnector } = options;
  const resolved = {
    claude: executables.claude ?? process.env.CHOPSTICKS_CLAUDE_BIN,
    codex: executables.codex ?? process.env.CHOPSTICKS_CODEX_BIN,
    grok: executables.grok ?? process.env.CHOPSTICKS_GROK_BIN,
  };
  let grokBackend: GrokBackend | undefined;

  return [
    {
      kind: 'claude',
      createSession: ({ cwd, resume, title, host, agentOptions }) => {
        const launch = agentOptions as ClaudeAgentOptions | undefined;
        return createClaudeSession({
          cwd,
          resume,
          title,
          executable: resolved.claude,
          permissionMode: launch?.permissionMode,
          model: launch?.model,
          ports: {
            spawn: (prepared) => host.spawnTerminal(prepared),
            automate: host.automateTerminal,
          },
        });
      },
    },
    {
      kind: 'codex',
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as CodexAgentOptions | undefined;
        return createCodexTuiSession({
          cwd,
          resume,
          executable: resolved.codex,
          host,
          model: launch?.model,
          sandbox: launch?.sandbox,
          approvalPolicy: launch?.approvalPolicy,
          onApproval: launch?.onApproval,
        });
      },
    },
    {
      kind: 'acp',
      createSession: ({ cwd, resume, agentOptions }) => {
        const launch = agentOptions as AcpAgentOptions | undefined;
        const connector = launch?.connector ?? acpConnector;
        if (!connector) {
          throw new Error('ACP sessions require agentOptions.connector or BuiltinProviderOptions.acpConnector');
        }
        return createAcpSession({
          cwd,
          resume,
          connector,
          clientCapabilities: launch?.clientCapabilities,
          onApproval: launch?.onApproval,
        });
      },
    },
    {
      kind: 'grok',
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as GrokAgentOptions | undefined;
        grokBackend ??= createGrokBackend({ executable: resolved.grok, host });
        return grokBackend.createSession({
          cwd,
          resume,
          model: launch?.model,
          permissionMode: launch?.permissionMode,
          sandbox: launch?.sandbox,
          clientCapabilities: launch?.clientCapabilities,
          onApproval: launch?.onApproval,
        });
      },
      dispose() {
        grokBackend?.dispose();
        grokBackend = undefined;
      },
    },
  ];
}
