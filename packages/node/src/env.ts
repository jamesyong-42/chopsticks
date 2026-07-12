/**
 * Agent environment construction (DESIGN §23.2): never forward the parent
 * environment wholesale — everything beyond the base set is an explicit grant.
 */

export interface AgentEnvironmentRequest {
  path?: string;
  home?: string;
  locale?: string;
  /** Explicit grants: credentials, adapter variables, hook tokens. */
  allowed?: Record<string, string>;
}

export function buildAgentEnvironment(request: AgentEnvironmentRequest = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: request.path ?? process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: request.locale ?? process.env.LANG ?? 'en_US.UTF-8',
  };
  const home = request.home ?? process.env.HOME;
  if (home) env.HOME = home;
  return { ...env, ...request.allowed };
}
