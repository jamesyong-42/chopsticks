#!/usr/bin/env node
// Bundle the workbench: CommonJS main (the Electron main entry; the ESM-only
// avocado SDK is inlined into it), CJS sandboxed preload, and a browser renderer
// with its CSS sidecar. The pty-host is NOT bundled — it runs from src/ under
// tsx so it can import workspace TS (and the avocado SDK's ESM) directly.

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
  // @vibecook/avocado-sdk AND @vibecook/chopsticks-adapter-claude (+ its dep
  // @vibecook/spaghetti-sdk) are ESM; Electron 32's Node (20.18) cannot
  // require() an ES module, so bundle them in rather than leaving them external.
  // @vibecook/chopsticks-workspaces is likewise bundled (pure TS over
  // node:child_process; no native deps, no new externals) by being absent from
  // the external list below — esbuild inlines its TS the same way.
  // electron/tsx are resolved at runtime; node-pty is never loaded here (the
  // pty-host owns all PTYs) so it stays external to avoid pulling the native
  // module into the Electron main bundle. @parcel/watcher (spaghetti-sdk's
  // transitive native dep) is N-API — ABI-stable and loads fine in Electron —
  // but must stay external so esbuild doesn't try to inline its .node binary.
  // It is also declared as a direct workbench dependency so the emitted
  // `require('@parcel/watcher')` resolves from apps/workbench/node_modules under
  // pnpm's strict, non-hoisted layout.
  build({
    ...shared,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(dist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron', 'tsx', 'node-pty', '@parcel/watcher'],
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
