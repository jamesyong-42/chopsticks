/**
 * @vibecook/chopsticks-core — contracts for the chopsticks agent runtime.
 *
 * Zero I/O by design (DESIGN §8, acceptance criterion 19): types, the session
 * state reducer, and pure helpers only. Anything touching a PTY, process,
 * socket, or file lives in @vibecook/chopsticks-node or an adapter package.
 */

export * from './events.js';
export * from './state.js';
export * from './session.js';
export * from './host.js';

export const CHOPSTICKS_CORE_VERSION = '0.1.4'; // x-release-please-version
