import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicPackages } from './public-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = mkdtempSync(join(tmpdir(), 'chopsticks-packs-'));

try {
  for (const [directory] of publicPackages) {
    const result = spawnSync('pnpm', ['--dir', directory, 'pack', '--pack-destination', destination], {
      cwd: root,
      stdio: 'inherit',
    });

    if (result.status !== 0) {
      throw new Error(`Failed to pack ${directory}`);
    }
  }

  const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz'));

  if (tarballs.length !== publicPackages.length) {
    throw new Error(`Expected ${publicPackages.length} tarballs, found ${tarballs.length}`);
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
