/**
 * AgentHost — the terminal/process capability an application (the workbench, a
 * CLI, …) lends to an adapter so the adapter can own its FULL native-TUI spawn
 * recipe without owning PTY infrastructure. This lifts the Claude adapter's
 * `ports` shape (DESIGN §16) into core so every adapter shares ONE injection
 * point, and it is what lets the Codex app-server + `codex --remote` and the
 * Grok leader + `grok --leader` recipes move out of the app and into their
 * adapters (ADR-007: process lifecycle belongs to the host; the adapter only
 * asks the host to spawn/write, and observes/controls the result).
 */

/** A native terminal (PTY) the host should spawn on the adapter's behalf. */
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
export interface AgentHost {
  /** Spawn a native terminal for the agent; returns the host's routing id. */
  spawnTerminal(spec: TerminalSpec): Promise<{ runtimeSessionId: string }>;
  /**
   * Write bytes straight to a terminal, bypassing the human-input path so an
   * injected paste is never mistaken for a user keystroke (DESIGN §17.2).
   */
  writeTerminal(runtimeSessionId: string, data: string): void;
}

/**
 * The options every native-TUI session factory accepts. Each adapter's
 * `createXTuiSession` extends this with its own extras (executable, sandbox, …)
 * and returns an {@link AgentSession} whose `runtimeSessionId` is the terminal
 * the host spawned and whose `dispose()` tears down the adapter's own backing
 * services (observer, app-server, leader client).
 */
export interface AgentTuiSessionOptions {
  cwd: string;
  /** Resume an existing session by its native/join id. */
  resume?: string;
  /** The host capability the adapter spawns/writes its terminal through. */
  host: AgentHost;
}
