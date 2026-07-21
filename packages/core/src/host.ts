/**
 * AgentHost — the terminal/process capability an application (the workbench, a
 * CLI, …) lends to an adapter so the adapter can own its FULL native-TUI launch
 * recipe without owning PTY infrastructure. The normal path asks the host to
 * spawn it; split-phase preparation can instead bind the recipe to an existing
 * caller-owned terminal before an external shim execs it. This lifts the
 * Claude adapter's `ports` shape (DESIGN §16) into core so every adapter shares
 * ONE injection point. It is what lets the Codex app-server + `codex --remote`
 * and Grok leader + `grok --leader` recipes move out of the app and into their
 * adapters (ADR-007: process lifecycle belongs to the host; the adapter only
 * asks the host to spawn/automate, or binds an existing terminal, and
 * observes/controls the result).
 */

/** An authoritative native terminal recipe for a host spawn or caller-owned exec. */
export interface TerminalSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Extra environment for the spawned process (merged over the host's base). */
  env?: Record<string, string>;
  /** Initial geometry; the host may substitute its own default when omitted. */
  cols?: number;
  rows?: number;
}

/**
 * The capability surface an adapter needs from its host. Deliberately tiny:
 * spawn a terminal and write raw bytes to one. Everything else (transcripts,
 * app-servers, leaders, sockets) the adapter builds itself.
 */
export type TerminalAutomationOperation =
  { kind: 'paste'; text: string; submit: boolean } | { kind: 'text'; text: string } | { kind: 'interrupt' };

export type TerminalAutomationResult =
  { accepted: true } | { accepted: false; reason: 'human-input-conflict' | string };

export interface AgentHost {
  /** Spawn a native terminal for the agent; returns the host's routing id. */
  spawnTerminal(spec: TerminalSpec): Promise<{ runtimeSessionId: string }>;
  /**
   * Submit one semantic automation operation. The terminal service orders it
   * atomically against accepted human input without attaching a view, taking
   * focus, or claiming resize control.
   */
  automateTerminal(runtimeSessionId: string, operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
}

/**
 * The options every native-TUI session factory accepts. Each adapter's
 * `createXTuiSession` extends this with its own extras (executable, sandbox, …)
 * and returns an {@link AgentSession} whose `runtimeSessionId` is the terminal
 * the host spawned or the caller adopted and whose `dispose()` tears down the
 * adapter's own backing services (observer, app-server, leader client).
 */
export interface AgentTuiSessionOptions {
  cwd: string;
  /** Resume an existing session by its native/join id. */
  resume?: string;
  /** The host capability the adapter spawns/writes its terminal through. */
  host: AgentHost;
}
