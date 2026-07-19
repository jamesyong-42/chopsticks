import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { publicPackages } from './public-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const rootManifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const version = rootManifest.version;
const expectedTag = `v${version}`;

let tag;
try {
  tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  throw new Error(`Expected ${expectedTag} at HEAD; no exact tag found`);
}

if (tag !== expectedTag) {
  throw new Error(`Expected ${expectedTag} at HEAD, found ${tag}`);
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
    // A missing version is expected during a new or partially completed release.
  }

  const result = spawnSync('pnpm', ['--dir', directory, 'publish', '--access', 'public', '--no-git-checks'], {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
