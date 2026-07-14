/**
 * @vibecook/chopsticks-adapter-acp — generic Agent Client Protocol adapter.
 *
 * ACP (agentclientprotocol.com) is a standardized JSON-RPC surface adopted by a
 * growing agent ecosystem (Grok, Zed, Neovim, …). Because it's structured, this
 * adapter is a `structured` driver — the sibling of the Codex app-server
 * adapter, not a PTY+transcript clone of the Claude adapter. One driver serves
 * every ACP agent; Grok (`grok agent stdio`) is the first (M6).
 *
 * A2 ships the `session/update` normalizer; A3 the driver + connection wiring
 * and deterministic `session/prompt` injection.
 */

export * from './normalizer.js';
export * from './connection.js';
export * from './driver.js';
