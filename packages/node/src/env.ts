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

/**
 * Base PTY env for interactive shells and agent TUIs.
 *
 * Matches avocado/apps/ghostty (Claude Code fullscreen + full mouse + truecolor).
 * See avocado docs/internal/CLAUDE-CODE-MOUSE-SELECTION.md.
 */
export function buildAgentEnvironment(request: AgentEnvironmentRequest = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: request.path ?? process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    TERM_PROGRAM: 'ghostty',
    TERM_PROGRAM_VERSION: '1.2.0',
    // Prefer Claude fullscreen entry; leave DISABLE_* unset (not "0").
    CLAUDE_CODE_NO_FLICKER: '1',
    LANG: request.locale ?? process.env.LANG ?? 'en_US.UTF-8',
  };
  const home = request.home ?? process.env.HOME;
  if (home) env.HOME = home;
  return { ...env, ...request.allowed };
}
