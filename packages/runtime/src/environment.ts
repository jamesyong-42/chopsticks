/**
 * Construct the explicit environment granted to an agent TUI. The runtime
 * owns this policy; terminal transports must not leak the full parent process
 * environment as an accidental capability.
 */
export interface AgentEnvironmentRequest {
  path?: string;
  home?: string;
  locale?: string;
  allowed?: Record<string, string>;
}

export function buildAgentEnvironment(request: AgentEnvironmentRequest = {}): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: request.path ?? process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    TERM_PROGRAM: 'ghostty',
    TERM_PROGRAM_VERSION: '1.2.0',
    CLAUDE_CODE_NO_FLICKER: '1',
    LANG: request.locale ?? process.env.LANG ?? 'en_US.UTF-8',
  };
  const home = request.home ?? process.env.HOME;
  if (home) environment.HOME = home;
  return { ...environment, ...request.allowed };
}
