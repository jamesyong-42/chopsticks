import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { publicPackages } from './public-packages.mjs';
import { isAlreadyPublishedError } from './publish-errors.mjs';

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

function publish(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--dir', directory, 'publish', '--access', 'public', '--no-git-checks'], {
      cwd: root,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const output = [];

    child.stdout.on('data', (chunk) => {
      output.push(Buffer.from(chunk));
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output.push(Buffer.from(chunk));
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, output: Buffer.concat(output).toString('utf8') });
    });
  });
}

for (const [directory, expectedName] of publicPackages) {
  const manifest = JSON.parse(readFileSync(`${root}/${directory}/package.json`, 'utf8'));

  if (manifest.name !== expectedName || manifest.version !== version) {
    throw new Error(`${directory} must be ${expectedName}@${version}; found ${manifest.name}@${manifest.version}`);
  }

  try {
    execFileSync('npm', ['view', `${expectedName}@${version}`, 'version'], {
      cwd: root,
      stdio: 'ignore',
    });
    console.log(`${expectedName}@${version} already published; skipping`);
    continue;
  } catch {
    // A missing or not-yet-visible version is expected during a partial release.
  }

  const result = await publish(directory);

  if (result.status !== 0) {
    if (isAlreadyPublishedError(result.output, version)) {
      console.log(`${expectedName}@${version} was previously published; skipping`);
      continue;
    }

    process.exit(result.status ?? 1);
  }
}
