import { execFileSync, spawnSync } from 'node:child_process';

import { publicPackages } from './public-packages.mjs';

const [major, minor] = execFileSync('npm', ['--version'], {
  encoding: 'utf8',
})
  .trim()
  .split('.')
  .map(Number);

if (major < 11 || (major === 11 && minor < 15)) {
  throw new Error('npm 11.15 or newer is required for npm trust');
}

for (const [, packageName] of publicPackages) {
  const result = spawnSync(
    'npm',
    [
      'trust',
      'github',
      packageName,
      '--file',
      'release.yml',
      '--repo',
      'jamesyong-42/chopsticks',
      '--allow-publish',
      '--yes',
    ],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
}
