/**
 * Workspace isolation (DESIGN §20).
 *
 * Three providers behind one Workspace handle:
 * - shared:   the caller's directory as-is. destroy() is a NO-OP by contract —
 *             this provider never owns the directory and never deletes state.
 * - worktree: `git worktree add -b chopsticks/<id>` materialized OUTSIDE the
 *             repository (under workspacesRoot). The branch is the session's
 *             work product: destroy() removes the worktree but keeps the
 *             branch unless deleteBranch is explicit. A dirty worktree refuses
 *             destruction without { force: true } — silent loss is never the
 *             default (§20.3 spirit, and the global no-destroy rule).
 * - copy:     a recursive copy for non-git directories (or when git isolation
 *             is unwanted). destroy() removes the copy, guarded to paths this
 *             module materialized.
 *
 * The §20.3 policy — one writer per shared root — is a pure check the host
 * calls before creating a session (assertWorkspacePolicy).
 */

import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { filesFromPorcelain, git, headCommit, isGitRepo, parseShortstat, porcelainStatus } from './git.js';

export type WorkspaceIsolation = 'shared' | 'worktree' | 'copy';

export interface WorkspaceRequest {
  /** Repository root (shared/worktree) or source directory (copy). */
  path: string;
  isolation: WorkspaceIsolation;
  /** worktree: ref to branch from; default HEAD. */
  baseRef?: string;
  /** worktree: branch name; default chopsticks/<id>. */
  branchName?: string;
  /** Where worktrees/copies materialize; default ~/.chopsticks/workspaces. */
  workspacesRoot?: string;
}

export interface WorkspaceDiff {
  filesTouched: string[];
  insertions: number;
  deletions: number;
  /** Raw `status --porcelain` for display. Empty for non-git roots. */
  porcelain: string;
}

/** DESIGN §20.4 — recorded per session for the operational record. */
export interface WorkspaceSessionMetadata {
  root: string;
  isolation: WorkspaceIsolation;
  branch?: string;
  initialCommit?: string;
  /** Files already dirty at creation (shared roots) — subtract for attribution. */
  initialDirtyFiles: string[];
  finalCommit?: string;
  finalDiff: WorkspaceDiff;
  filesTouched: string[];
}

export interface Workspace {
  readonly id: string;
  /** The session's cwd. */
  readonly root: string;
  readonly isolation: WorkspaceIsolation;
  readonly sourcePath: string;
  readonly branch?: string;
  readonly initialCommit?: string;
  readonly initialDirtyFiles: readonly string[];
  diff(): Promise<WorkspaceDiff>;
  finalize(): Promise<WorkspaceSessionMetadata>;
  destroy(options?: { force?: boolean; deleteBranch?: boolean }): Promise<void>;
}

export type WorkspaceErrorCode = 'WORKSPACE_CREATE_FAILED' | 'WORKSPACE_CONFLICT' | 'WORKSPACE_DIRTY';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

const DEFAULT_WORKSPACES_ROOT = path.join(homedir(), '.chopsticks', 'workspaces');

async function gitDiff(root: string): Promise<WorkspaceDiff> {
  if (!(await isGitRepo(root))) {
    return { filesTouched: [], insertions: 0, deletions: 0, porcelain: '' };
  }
  const porcelain = await porcelainStatus(root);
  const head = await headCommit(root);
  const shortstat = head ? await git(root, 'diff', 'HEAD', '--shortstat') : '';
  return {
    filesTouched: filesFromPorcelain(porcelain),
    ...parseShortstat(shortstat),
    porcelain,
  };
}

export async function createWorkspace(request: WorkspaceRequest): Promise<Workspace> {
  try {
    await stat(request.path);
  } catch {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `workspace source does not exist: ${request.path}`);
  }

  const id = randomUUID().slice(0, 8);
  const workspacesRoot = request.workspacesRoot ?? DEFAULT_WORKSPACES_ROOT;

  switch (request.isolation) {
    case 'shared':
      return createShared(id, request.path);
    case 'worktree':
      return createWorktree(id, request, workspacesRoot);
    case 'copy':
      return createCopy(id, request.path, workspacesRoot);
  }
}

function makeFinalize(workspace: Omit<Workspace, 'finalize' | 'destroy'>): () => Promise<WorkspaceSessionMetadata> {
  return async () => {
    const finalDiff = await workspace.diff();
    return {
      root: workspace.root,
      isolation: workspace.isolation,
      branch: workspace.branch,
      initialCommit: workspace.initialCommit,
      initialDirtyFiles: [...workspace.initialDirtyFiles],
      finalCommit: await headCommit(workspace.root),
      finalDiff,
      filesTouched: finalDiff.filesTouched,
    };
  };
}

async function createShared(id: string, root: string): Promise<Workspace> {
  const inRepo = await isGitRepo(root);
  const initialCommit = inRepo ? await headCommit(root) : undefined;
  const initialDirtyFiles = inRepo ? filesFromPorcelain(await porcelainStatus(root)) : [];

  const base = {
    id,
    root,
    isolation: 'shared' as const,
    sourcePath: root,
    branch: undefined,
    initialCommit,
    initialDirtyFiles,
    diff: () => gitDiff(root),
  };
  return {
    ...base,
    finalize: makeFinalize(base),
    // Contract, not laziness: shared roots belong to the user.
    destroy: async () => undefined,
  };
}

async function createWorktree(id: string, request: WorkspaceRequest, workspacesRoot: string): Promise<Workspace> {
  if (!(await isGitRepo(request.path))) {
    throw new WorkspaceError(
      'WORKSPACE_CREATE_FAILED',
      `worktree isolation requires a git repository: ${request.path}`,
    );
  }
  const branch = request.branchName ?? `chopsticks/${id}`;
  const base = request.baseRef ?? 'HEAD';
  const root = path.join(workspacesRoot, id);
  await mkdir(workspacesRoot, { recursive: true });

  try {
    await git(request.path, 'worktree', 'add', '-b', branch, root, base);
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `git worktree add failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const workspaceBase = {
    id,
    root,
    isolation: 'worktree' as const,
    sourcePath: request.path,
    branch,
    initialCommit: await headCommit(root),
    initialDirtyFiles: [] as string[],
    diff: () => gitDiff(root),
  };
  return {
    ...workspaceBase,
    finalize: makeFinalize(workspaceBase),
    async destroy(options) {
      if (!options?.force) {
        const dirty = filesFromPorcelain(await porcelainStatus(root));
        if (dirty.length > 0) {
          throw new WorkspaceError(
            'WORKSPACE_DIRTY',
            `worktree has ${dirty.length} uncommitted change(s); destroy with { force: true } to discard`,
          );
        }
      }
      const args = ['worktree', 'remove', root];
      if (options?.force) args.push('--force');
      await git(request.path, ...args);
      // The branch is the work product; deletion is an explicit choice.
      if (options?.deleteBranch) await git(request.path, 'branch', '-D', branch);
    },
  };
}

async function createCopy(id: string, source: string, workspacesRoot: string): Promise<Workspace> {
  const root = path.join(workspacesRoot, id);
  await mkdir(workspacesRoot, { recursive: true });
  try {
    await cp(source, root, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `copy failed: ${(err as Error).message}`, { cause: err });
  }

  const base = {
    id,
    root,
    isolation: 'copy' as const,
    sourcePath: source,
    branch: undefined,
    initialCommit: await headCommit(root),
    initialDirtyFiles: [] as string[],
    diff: () => gitDiff(root),
  };
  return {
    ...base,
    finalize: makeFinalize(base),
    async destroy() {
      // Only ever remove what this module materialized.
      if (!root.startsWith(workspacesRoot + path.sep)) {
        throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `refusing to remove path outside workspacesRoot: ${root}`);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * DESIGN §20.3 — one writer per shared root: a second concurrent session on
 * the same repository must take worktree or copy isolation.
 */
export function assertWorkspacePolicy(active: readonly Workspace[], request: WorkspaceRequest): void {
  if (request.isolation !== 'shared') return;
  const requested = path.resolve(request.path);
  const conflict = active.find((w) => w.isolation === 'shared' && path.resolve(w.sourcePath) === requested);
  if (conflict) {
    throw new WorkspaceError(
      'WORKSPACE_CONFLICT',
      `a shared workspace (${conflict.id}) is already active on ${requested}; use worktree or copy isolation`,
    );
  }
}
