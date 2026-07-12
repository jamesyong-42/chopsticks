#!/usr/bin/env node
// Bundle the workbench: ESM main (Electron ≥28 ESM entry), CJS sandboxed
// preload, and a browser renderer with its CSS sidecar. The pty-host is NOT
// bundled — it runs from src/ under tsx so it can import workspace TS directly.

import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const shared = { bundle: true, sourcemap: true, logLevel: 'info' };

await mkdir(dist, { recursive: true });

await Promise.all([
  // Electron main: CommonJS (the conventional Electron main entry format).
  // packages stay external so electron/tsx resolve at runtime.
  build({
    ...shared,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(dist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
  }),
  // Preload must be CommonJS under sandbox: true; only electron is external.
  build({
    ...shared,
    entryPoints: [join(root, 'src/preload/preload.ts')],
    outfile: join(dist, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  // Renderer: everything (xterm + css) bundled for the browser context.
  build({
    ...shared,
    entryPoints: [join(root, 'src/renderer/main.ts')],
    outdir: dist,
    entryNames: 'renderer',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  }),
]);

await cp(join(root, 'src/renderer/index.html'), join(dist, 'index.html'));
// Touch a marker so `ls dist` after a failed build is unambiguous.
await writeFile(join(dist, '.built'), new Date().toISOString());
