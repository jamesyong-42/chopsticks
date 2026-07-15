/**
 * Session workspaces behind one handle.
 *
 * - direct:    use the caller's directory as-is; any number of agents may use it.
 * - exclusive: use the caller's directory as-is; the runtime owns the cooperative
 *              lease that prevents another direct/exclusive session there.
 * - worktree:  materialize a Git worktree outside the repository. Clean
 *              worktrees are removed on exit while their branch is retained;
 *              dirty worktrees are retained and can be adopted on resume.
 * - copy:      an internal/advanced provider for non-Git directory copies.
 */

import { randomUUID } from 'node:crypto';
import { cp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { filesFromPorcelain, git, headCommit, isGitRepo, parseShortstat, porcelainStatus } from './git.js';

export type WorkspaceMode = 'direct' | 'exclusive' | 'worktree' | 'copy';

export interface WorkspaceRequest {
  /** Working directory (direct/exclusive), repository (worktree), or source (copy). */
  path: string;
  mode: WorkspaceMode;
  /** New worktree: ref to branch from; default HEAD. */
  baseRef?: string;
  /** New worktree: branch name; default chopsticks/<id>. */
  branchName?: string;
  /** Resume a previously created worktree branch. */
  resumeBranch?: string;
  /** Adopt a retained worktree instead of materializing it again. */
  resumeRoot?: string;
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

export interface WorkspaceSessionMetadata {
  root: string;
  sourcePath: string;
  mode: WorkspaceMode;
  branch?: string;
  initialCommit?: string;
  /** Files already dirty at creation, excluded from best-effort attribution. */
  initialDirtyFiles: string[];
  finalCommit?: string;
  finalDiff: WorkspaceDiff;
  filesTouched: string[];
}

export interface Workspace {
  readonly id: string;
  /** The session's cwd. */
  readonly root: string;
  /** Canonical identity used by the runtime's cooperative lease policy. */
  readonly identity: string;
  readonly mode: WorkspaceMode;
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

/**
 * Canonical cooperative-lock identity. Paths inside the same checkout (and
 * symlinks to it) collapse to that checkout's real Git top-level directory.
 */
export async function workspaceIdentity(source: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(source);
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `workspace source does not exist: ${source}`, {
      cause: err,
    });
  }

  if (!(await isGitRepo(resolved))) return resolved;
  try {
    return await realpath(await git(resolved, 'rev-parse', '--show-toplevel'));
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `could not resolve Git workspace root: ${source}`, {
      cause: err,
    });
  }
}

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

  switch (request.mode) {
    case 'direct':
    case 'exclusive':
      return createInPlace(id, request.path, request.mode);
    case 'worktree':
      return createWorktree(id, request, workspacesRoot);
    case 'copy':
      return createCopy(id, request.path, workspacesRoot);
  }
}

function makeFinalize(workspace: Omit<Workspace, 'finalize' | 'destroy'>): () => Promise<WorkspaceSessionMetadata> {
  return async () => {
    const finalDiff = await workspace.diff();
    const finalCommit = await headCommit(workspace.root);
    let committedFiles: string[] = [];
    if (workspace.initialCommit && finalCommit && workspace.initialCommit !== finalCommit) {
      committedFiles = (await git(workspace.root, 'diff', '--name-only', workspace.initialCommit, finalCommit))
        .split('\n')
        .filter(Boolean);
    }
    const initiallyDirty = new Set(workspace.initialDirtyFiles);
    const newlyDirty = finalDiff.filesTouched.filter((file) => !initiallyDirty.has(file));

    return {
      root: workspace.root,
      sourcePath: workspace.sourcePath,
      mode: workspace.mode,
      branch: workspace.branch,
      initialCommit: workspace.initialCommit,
      initialDirtyFiles: [...workspace.initialDirtyFiles],
      finalCommit,
      finalDiff,
      filesTouched: [...new Set([...committedFiles, ...newlyDirty])].sort(),
    };
  };
}

async function createInPlace(id: string, requestedRoot: string, mode: 'direct' | 'exclusive'): Promise<Workspace> {
  const root = await realpath(requestedRoot);
  const identity = await workspaceIdentity(root);
  const inRepo = await isGitRepo(root);
  const initialCommit = inRepo ? await headCommit(root) : undefined;
  const initialDirtyFiles = inRepo ? filesFromPorcelain(await porcelainStatus(root)) : [];

  const base = {
    id,
    root,
    identity,
    mode,
    sourcePath: root,
    branch: undefined,
    initialCommit,
    initialDirtyFiles,
    diff: () => gitDiff(root),
  };
  return {
    ...base,
    finalize: makeFinalize(base),
    // In-place roots belong to the user and are never removed by this module.
    destroy: async () => undefined,
  };
}

async function assertRetainedWorktree(source: string, root: string, branch: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const entries = (await git(source, 'worktree', 'list', '--porcelain')).split('\n\n');
  const expectedBranch = `refs/heads/${branch}`;
  const match = entries.find((entry) => {
    const lines = entry.split('\n');
    return lines.includes(`worktree ${canonicalRoot}`) && lines.includes(`branch ${expectedBranch}`);
  });
  if (!match) {
    throw new WorkspaceError(
      'WORKSPACE_CREATE_FAILED',
      `retained worktree is not registered for branch ${branch}: ${canonicalRoot}`,
    );
  }
}

async function createWorktree(id: string, request: WorkspaceRequest, workspacesRoot: string): Promise<Workspace> {
  if (!(await isGitRepo(request.path))) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `worktree mode requires a git repository: ${request.path}`);
  }
  if (request.resumeRoot && !request.resumeBranch) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', 'resumeRoot requires resumeBranch');
  }

  const sourcePath = await workspaceIdentity(request.path);
  const branch = request.resumeBranch ?? request.branchName ?? `chopsticks/${id}`;
  let root = path.join(workspacesRoot, id);
  if (request.resumeRoot) {
    try {
      root = await realpath(request.resumeRoot);
    } catch (err) {
      throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `retained worktree does not exist: ${request.resumeRoot}`, {
        cause: err,
      });
    }
  }

  if (request.resumeRoot) {
    await assertRetainedWorktree(sourcePath, root, branch);
  } else {
    await mkdir(workspacesRoot, { recursive: true });
    try {
      if (request.resumeBranch) await git(sourcePath, 'worktree', 'add', root, branch);
      else await git(sourcePath, 'worktree', 'add', '-b', branch, root, request.baseRef ?? 'HEAD');
    } catch (err) {
      throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `git worktree add failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
    root = await realpath(root);
  }

  const initialDirtyFiles = filesFromPorcelain(await porcelainStatus(root));
  const workspaceBase = {
    id,
    root,
    identity: await workspaceIdentity(root),
    mode: 'worktree' as const,
    sourcePath,
    branch,
    initialCommit: await headCommit(root),
    initialDirtyFiles,
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
      await git(sourcePath, ...args);
      // The branch is the work product; deletion is an explicit choice.
      if (options?.deleteBranch) await git(sourcePath, 'branch', '-D', branch);
    },
  };
}

async function createCopy(id: string, source: string, workspacesRoot: string): Promise<Workspace> {
  const sourcePath = await realpath(source);
  const root = path.join(workspacesRoot, id);
  await mkdir(workspacesRoot, { recursive: true });
  try {
    await cp(sourcePath, root, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `copy failed: ${(err as Error).message}`, { cause: err });
  }

  const base = {
    id,
    root,
    identity: await realpath(root),
    mode: 'copy' as const,
    sourcePath,
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
