/**
 * @vibecook/chopsticks-adapter-acp — generic Agent Client Protocol adapter.
 *
 * ACP (agentclientprotocol.com) is a standardized JSON-RPC surface adopted by a
 * growing agent ecosystem. Because it's structured, this
 * adapter is a `structured` driver — the sibling of the Codex app-server
 * adapter, not a PTY+transcript clone of the Claude adapter. Agent-specific
 * commands, native TUIs, and service lifetimes belong in packages that compose
 * this one.
 */

export * from './normalizer.js';
export * from './connection.js';
export * from './driver.js';
