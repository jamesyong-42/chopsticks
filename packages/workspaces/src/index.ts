/**
 * @vibecook/chopsticks-workspaces — session workspace isolation (DESIGN §20):
 * shared / git-worktree / copy providers, final-diff metadata, and the
 * one-writer-per-shared-root policy check.
 */

export * from './workspace.js';
export { filesFromPorcelain, parseShortstat } from './git.js';
