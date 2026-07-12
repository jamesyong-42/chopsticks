#!/usr/bin/env node
// pnpm's tarball extraction drops the executable bit on node-pty's prebuilt
// spawn-helper (posix_spawnp then fails at PTY spawn). Restore it after every
// install. Harmless no-op when node-pty is absent or already correct.

import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm');
let fixed = 0;
try {
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith('node-pty@')) continue;
    const prebuilds = join(pnpmDir, entry, 'node_modules', 'node-pty', 'prebuilds');
    let platforms = [];
    try {
      platforms = readdirSync(prebuilds);
    } catch {
      continue;
    }
    for (const platform of platforms) {
      const helper = join(prebuilds, platform, 'spawn-helper');
      try {
        const mode = statSync(helper).mode;
        if ((mode & 0o111) === 0) {
          chmodSync(helper, mode | 0o755);
          fixed++;
        }
      } catch {
        /* no helper on this platform */
      }
    }
  }
} catch {
  /* no .pnpm dir yet */
}
if (fixed > 0) console.log(`fix-node-pty-perms: restored exec bit on ${fixed} spawn-helper binar${fixed === 1 ? 'y' : 'ies'}`);
