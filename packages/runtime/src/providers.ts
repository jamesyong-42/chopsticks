import { createClaudeSession } from '@vibecook/chopsticks-adapter-claude';
import { createCodexTuiSession } from '@vibecook/chopsticks-adapter-codex';
import { createGrokBackend, type GrokBackend } from '@vibecook/chopsticks-adapter-grok';
import type { AgentProvider, BuiltinAgentKind, ClaudeAgentOptions, CodexAgentOptions } from './types.js';

export interface BuiltinProviderOptions {
  executables?: Partial<Record<BuiltinAgentKind, string>>;
}

/**
 * Construct the built-in providers. All CLI-specific recipes and shared service
 * lifetimes terminate here; callers only see AgentProvider/AgentRuntime.
 */
export function createBuiltinProviders(options: BuiltinProviderOptions = {}): AgentProvider[] {
  const { executables = {} } = options;
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
          sandbox: launch?.sandbox,
          approvalPolicy: launch?.approvalPolicy,
        });
      },
    },
    {
      kind: 'grok',
      createSession: ({ cwd, resume, host }) => {
        grokBackend ??= createGrokBackend({ executable: resolved.grok, host });
        return grokBackend.createSession({ cwd, resume });
      },
      dispose() {
        grokBackend?.dispose();
        grokBackend = undefined;
      },
    },
  ];
}
