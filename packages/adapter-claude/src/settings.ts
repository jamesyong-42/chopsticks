/**
 * Generated Claude Code hook settings (DESIGN §16.5: settings are generated
 * from the registry, never handwritten). Output structure and the two handler
 * shapes are the ones Claude 2.1.207 accepted live in Phase 0
 * (probe/http-probe-settings.json for http, probe/census-settings.json for the
 * command-forwarder nesting).
 *
 * Transport split follows the hybrid bridge (DESIGN §16.4): http events POST
 * straight to the loopback bridge; command events run a curl forwarder that
 * relays the same stdin JSON to the same bridge — no per-event node process.
 *
 * SECURITY (DESIGN §16.5, §23): settings land on disk, so the token VALUE is
 * never written here. Only the `$<VAR>` reference goes in, resolved at hook
 * time via Claude's `allowedEnvVars` env interpolation.
 */

import { verifiedHookEvents, type HookEventSpec } from './registry.js';

export interface HttpHookHandler {
  type: 'http';
  url: string;
  headers: Record<string, string>;
  allowedEnvVars: string[];
  timeout: number;
}

export interface CommandHookHandler {
  type: 'command';
  command: string;
}

export type HookHandler = HttpHookHandler | CommandHookHandler;

/** One matcher block; Claude nests handlers under `hooks` (`[{ hooks: [...] }]`). */
export interface HookMatcher {
  hooks: HookHandler[];
}

export interface ClaudeHookSettings {
  hooks: Record<string, HookMatcher[]>;
}

export interface GenerateHookSettingsOptions {
  /** Loopback bridge endpoint, e.g. http://127.0.0.1:<port>/hooks. */
  endpoint: string;
  /** Env var NAME holding the bearer token; only `$<name>` is written. */
  tokenEnvVar: string;
  /** Events to wire; defaults to the registry's verified set. */
  events?: readonly HookEventSpec[];
}

/**
 * curl forwarder for command-transport events: command hooks receive the event
 * JSON on stdin (proven by the census), and `--data-binary @-` relays it verbatim
 * to the same bridge with the same bearer auth. `-m` bounds it to the event's timeout.
 */
function curlForwarder(endpoint: string, tokenEnvVar: string, timeoutSec: number): string {
  return `sh -c 'curl -s -m ${timeoutSec} -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $${tokenEnvVar}" --data-binary @- ${endpoint}'`;
}

function handlerFor(spec: HookEventSpec, options: GenerateHookSettingsOptions): HookHandler {
  if (spec.transport === 'http') {
    return {
      type: 'http',
      url: options.endpoint,
      headers: { Authorization: `Bearer $${options.tokenEnvVar}` },
      allowedEnvVars: [options.tokenEnvVar],
      timeout: spec.timeoutSec,
    };
  }
  return { type: 'command', command: curlForwarder(options.endpoint, options.tokenEnvVar, spec.timeoutSec) };
}

export function generateHookSettings(options: GenerateHookSettingsOptions): ClaudeHookSettings {
  const events = options.events ?? verifiedHookEvents();
  const hooks: Record<string, HookMatcher[]> = {};
  for (const spec of events) {
    hooks[spec.event] = [{ hooks: [handlerFor(spec, options)] }];
  }
  return { hooks };
}
