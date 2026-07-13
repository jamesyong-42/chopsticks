/**
 * @vibecook/chopsticks-adapter-claude — Claude Code native adapter
 * (DESIGN §16): hook-event registry, loopback hook bridge, and the
 * hook → AgentEvent normalizer. Detection, settings generation, and the
 * native driver build on these.
 */

export * from './registry.js';
export * from './hook-bridge.js';
export * from './normalizer.js';
