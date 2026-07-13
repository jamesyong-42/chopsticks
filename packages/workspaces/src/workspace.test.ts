import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from './git.js';
import { assertWorkspacePolicy, createWorkspace, WorkspaceError, type Workspace } from './workspace.js';

/** A real repo with one commit; inline -c config keeps global git state untouched. */
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'ws-repo-'));
  await git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return repo;
}

const workspacesRoot = () => mkdtempSync(join(tmpdir(), 'ws-root-'));

describe('worktree isolation', () => {
  it('materializes an isolated worktree; writes never reach the source tree', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, isolation: 'worktree', workspacesRoot: workspacesRoot() });

    expect(ws.branch).toBe(`chopsticks/${ws.id}`);
    expect(ws.root).not.toBe(repo);
    expect(existsSync(join(ws.root, 'README.md'))).toBe(true);

    writeFileSync(join(ws.root, 'new-file.ts'), 'export {};\n');
    expect(existsSync(join(repo, 'new-file.ts'))).toBe(false); // isolation

    const diff = await ws.diff();
    expect(diff.filesTouched).toEqual(['new-file.ts']);
    await ws.destroy({ force: true });
  });

  it('finalize records initial/final commits and files touched', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, isolation: 'worktree', workspacesRoot: workspacesRoot() });

    writeFileSync(join(ws.root, 'work.txt'), 'output\n');
    await git(ws.root, 'add', '.');
    await git(ws.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'session work');

    const meta = await ws.finalize();
    expect(meta.initialCommit).toBeDefined();
    expect(meta.finalCommit).toBeDefined();
    expect(meta.finalCommit).not.toBe(meta.initialCommit);
    expect(meta.branch).toBe(ws.branch);
    expect(meta.finalDiff.filesTouched).toEqual([]); // committed → clean tree
    await ws.destroy();
  });

  it('refuses to destroy a dirty worktree without force, and keeps the branch either way', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, isolation: 'worktree', workspacesRoot: workspacesRoot() });
    writeFileSync(join(ws.root, 'uncommitted.txt'), 'precious\n');

    await expect(ws.destroy()).rejects.toMatchObject({ code: 'WORKSPACE_DIRTY' });
    expect(existsSync(ws.root)).toBe(true); // nothing was lost

    await ws.destroy({ force: true });
    expect(existsSync(ws.root)).toBe(false);
    // The branch survives as the work product.
    expect(await git(repo, 'branch', '--list', ws.branch!)).toContain(ws.branch!);
  });

  it('deleteBranch removes the branch only when explicit', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, isolation: 'worktree', workspacesRoot: workspacesRoot() });
    await ws.destroy({ deleteBranch: true });
    expect(await git(repo, 'branch', '--list', ws.branch!)).toBe('');
  });

  it('requires a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ws-plain-'));
    await expect(
      createWorkspace({ path: plain, isolation: 'worktree', workspacesRoot: workspacesRoot() }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CREATE_FAILED' });
  });
});

describe('shared isolation', () => {
  it('uses the source directory and captures pre-existing dirt', async () => {
    const repo = await makeRepo();
    writeFileSync(join(repo, 'already-dirty.txt'), 'x\n');

    const ws = await createWorkspace({ path: repo, isolation: 'shared' });
    expect(ws.root).toBe(repo);
    expect(ws.initialDirtyFiles).toEqual(['already-dirty.txt']);

    await ws.destroy(); // contract: no-op
    expect(existsSync(join(repo, 'already-dirty.txt'))).toBe(true);
    expect(existsSync(repo)).toBe(true);
  });
});

describe('copy isolation', () => {
  it('copies the source; mutations and destroy never touch it', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ws-src-'));
    writeFileSync(join(source, 'data.txt'), 'original\n');

    const ws = await createWorkspace({ path: source, isolation: 'copy', workspacesRoot: workspacesRoot() });
    expect(existsSync(join(ws.root, 'data.txt'))).toBe(true);

    writeFileSync(join(ws.root, 'data.txt'), 'mutated\n');
    writeFileSync(join(ws.root, 'extra.txt'), 'new\n');
    expect(existsSync(join(source, 'extra.txt'))).toBe(false);

    await ws.destroy();
    expect(existsSync(ws.root)).toBe(false);
    expect(existsSync(join(source, 'data.txt'))).toBe(true);
  });
});

describe('workspace policy (§20.3)', () => {
  const fakeShared = (id: string, sourcePath: string): Workspace =>
    ({ id, isolation: 'shared', sourcePath }) as Workspace;

  it('rejects a second shared workspace on the same root', async () => {
    const repo = await makeRepo();
    expect(() => assertWorkspacePolicy([fakeShared('a', repo)], { path: repo, isolation: 'shared' })).toThrowError(
      WorkspaceError,
    );
    expect(() => assertWorkspacePolicy([fakeShared('a', repo)], { path: repo, isolation: 'shared' })).toThrowError(
      /worktree or copy/,
    );
  });

  it('allows isolated workspaces beside a shared one, and shared roots on different paths', async () => {
    const repo = await makeRepo();
    const other = await makeRepo();
    expect(() => assertWorkspacePolicy([fakeShared('a', repo)], { path: repo, isolation: 'worktree' })).not.toThrow();
    expect(() => assertWorkspacePolicy([fakeShared('a', repo)], { path: other, isolation: 'shared' })).not.toThrow();
  });
});

describe('createWorkspace errors', () => {
  it('fails clearly for a missing source path', async () => {
    await expect(createWorkspace({ path: '/nonexistent/nowhere', isolation: 'shared' })).rejects.toMatchObject({
      code: 'WORKSPACE_CREATE_FAILED',
    });
  });
});
