import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { publicPackages } from './public-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const rootManifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const version = rootManifest.version;
const expectedTag = `v${version}`;
const releaseToolingFiles = new Set([
  'scripts/publish-errors.mjs',
  'scripts/publish-errors.test.mjs',
  'scripts/publish-packages.mjs',
]);

const tagCommit = execFileSync('git', ['rev-list', '-n', '1', expectedTag], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

if (tagCommit !== headCommit) {
  execFileSync('git', ['merge-base', '--is-ancestor', expectedTag, 'HEAD'], {
    cwd: root,
    stdio: 'ignore',
  });

  const changedFiles = execFileSync('git', ['diff', '--name-only', `${expectedTag}..HEAD`], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const unsafeFiles = changedFiles.filter((file) => !releaseToolingFiles.has(file));

  if (unsafeFiles.length > 0) {
    throw new Error(`${expectedTag} is not at HEAD; non-release files changed:\n${unsafeFiles.join('\n')}`);
  }
}

function isPublished(packageName) {
  try {
    execFileSync('npm', ['view', `${packageName}@${version}`, 'version', '--registry=https://registry.npmjs.org/'], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForPublished(packageName) {
  const attempts = 10;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isPublished(packageName)) {
      return true;
    }

    if (attempt < attempts) {
      console.log(`${packageName}@${version} is not visible yet; retrying registry check (${attempt}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  return false;
}

for (const [directory, expectedName] of publicPackages) {
  const manifest = JSON.parse(readFileSync(`${root}/${directory}/package.json`, 'utf8'));

  if (manifest.name !== expectedName || manifest.version !== version) {
    throw new Error(`${directory} must be ${expectedName}@${version}; found ${manifest.name}@${manifest.version}`);
  }

  if (isPublished(expectedName)) {
    console.log(`${expectedName}@${version} already published; skipping`);
    continue;
  }

  const result = spawnSync('pnpm', ['--dir', directory, 'publish', '--access', 'public', '--no-git-checks'], {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.log(
      `${expectedName}@${version} publish returned ${result.status ?? 'no status'}; checking registry before failing`,
    );

    if (await waitForPublished(expectedName)) {
      console.log(`${expectedName}@${version} is already published; continuing`);
      continue;
    }

    process.exit(result.status ?? 1);
  }
}
