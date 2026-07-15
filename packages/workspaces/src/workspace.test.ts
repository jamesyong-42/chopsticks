import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from './git.js';
import { createWorkspace, workspaceIdentity } from './workspace.js';

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

describe('worktree mode', () => {
  it('materializes an isolated worktree; writes never reach the source tree', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, mode: 'worktree', workspacesRoot: workspacesRoot() });

    expect(ws.branch).toBe(`chopsticks/${ws.id}`);
    expect(ws.root).not.toBe(repo);
    expect(existsSync(join(ws.root, 'README.md'))).toBe(true);

    writeFileSync(join(ws.root, 'new-file.ts'), 'export {};\n');
    expect(existsSync(join(repo, 'new-file.ts'))).toBe(false);

    const diff = await ws.diff();
    expect(diff.filesTouched).toEqual(['new-file.ts']);
    await ws.destroy({ force: true });
  });

  it('attributes committed files as well as final dirty files', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, mode: 'worktree', workspacesRoot: workspacesRoot() });

    writeFileSync(join(ws.root, 'work.txt'), 'output\n');
    await git(ws.root, 'add', '.');
    await git(ws.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'session work');

    const meta = await ws.finalize();
    expect(meta.initialCommit).toBeDefined();
    expect(meta.finalCommit).not.toBe(meta.initialCommit);
    expect(meta.branch).toBe(ws.branch);
    expect(meta.finalDiff.filesTouched).toEqual([]);
    expect(meta.filesTouched).toEqual(['work.txt']);
    await ws.destroy();
  });

  it('refuses to destroy a dirty worktree without force, and keeps the branch either way', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, mode: 'worktree', workspacesRoot: workspacesRoot() });
    writeFileSync(join(ws.root, 'uncommitted.txt'), 'precious\n');

    await expect(ws.destroy()).rejects.toMatchObject({ code: 'WORKSPACE_DIRTY' });
    expect(existsSync(ws.root)).toBe(true);

    await ws.destroy({ force: true });
    expect(existsSync(ws.root)).toBe(false);
    expect(await git(repo, 'branch', '--list', ws.branch!)).toContain(ws.branch!);
  });

  it('recreates a removed clean worktree from its preserved branch', async () => {
    const repo = await makeRepo();
    const first = await createWorkspace({ path: repo, mode: 'worktree', workspacesRoot: workspacesRoot() });
    writeFileSync(join(first.root, 'committed.txt'), 'kept on branch\n');
    await git(first.root, 'add', '.');
    await git(first.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'work');
    const branch = first.branch!;
    await first.destroy();

    const resumed = await createWorkspace({
      path: repo,
      mode: 'worktree',
      resumeBranch: branch,
      workspacesRoot: workspacesRoot(),
    });
    expect(resumed.branch).toBe(branch);
    expect(existsSync(join(resumed.root, 'committed.txt'))).toBe(true);
    await resumed.destroy();
  });

  it('adopts a retained dirty worktree on resume', async () => {
    const repo = await makeRepo();
    const first = await createWorkspace({ path: repo, mode: 'worktree', workspacesRoot: workspacesRoot() });
    writeFileSync(join(first.root, 'precious.txt'), 'uncommitted\n');
    await expect(first.destroy()).rejects.toMatchObject({ code: 'WORKSPACE_DIRTY' });

    const resumed = await createWorkspace({
      path: repo,
      mode: 'worktree',
      resumeBranch: first.branch,
      resumeRoot: first.root,
    });
    expect(resumed.root).toBe(first.root);
    expect(resumed.initialDirtyFiles).toEqual(['precious.txt']);
    await resumed.destroy({ force: true });
  });

  it('deletes the branch only when explicit', async () => {
    const repo = await makeRepo();
    const ws = await createWorkspace({ path: repo, mode: 'worktree', workspacesRoot: workspacesRoot() });
    await ws.destroy({ deleteBranch: true });
    expect(await git(repo, 'branch', '--list', ws.branch!)).toBe('');
  });

  it('requires a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ws-plain-'));
    await expect(
      createWorkspace({ path: plain, mode: 'worktree', workspacesRoot: workspacesRoot() }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CREATE_FAILED' });
  });
});

describe('in-place modes', () => {
  it.each(['direct', 'exclusive'] as const)('%s uses the source directory and never destroys it', async (mode) => {
    const repo = await makeRepo();
    writeFileSync(join(repo, 'already-dirty.txt'), 'x\n');

    const ws = await createWorkspace({ path: repo, mode });
    expect(ws.root).toBe(realpathSync(repo));
    expect(ws.mode).toBe(mode);
    expect(ws.initialDirtyFiles).toEqual(['already-dirty.txt']);

    await ws.destroy();
    expect(existsSync(join(repo, 'already-dirty.txt'))).toBe(true);
    expect(existsSync(repo)).toBe(true);
  });

  it('canonicalizes symlinks and repository subdirectories to one identity', async () => {
    const repo = await makeRepo();
    const subdir = join(repo, 'nested');
    mkdirSync(subdir);
    const alias = join(mkdtempSync(join(tmpdir(), 'ws-link-')), 'repo');
    symlinkSync(repo, alias);

    expect(await workspaceIdentity(subdir)).toBe(await workspaceIdentity(repo));
    expect(await workspaceIdentity(alias)).toBe(await workspaceIdentity(repo));
  });
});

describe('copy mode', () => {
  it('copies the source; mutations and destroy never touch it', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ws-src-'));
    writeFileSync(join(source, 'data.txt'), 'original\n');

    const ws = await createWorkspace({ path: source, mode: 'copy', workspacesRoot: workspacesRoot() });
    expect(existsSync(join(ws.root, 'data.txt'))).toBe(true);

    writeFileSync(join(ws.root, 'data.txt'), 'mutated\n');
    writeFileSync(join(ws.root, 'extra.txt'), 'new\n');
    expect(existsSync(join(source, 'extra.txt'))).toBe(false);

    await ws.destroy();
    expect(existsSync(ws.root)).toBe(false);
    expect(existsSync(join(source, 'data.txt'))).toBe(true);
  });
});

describe('createWorkspace errors', () => {
  it('fails clearly for a missing source path', async () => {
    await expect(createWorkspace({ path: '/nonexistent/nowhere', mode: 'direct' })).rejects.toMatchObject({
      code: 'WORKSPACE_CREATE_FAILED',
    });
  });
});
