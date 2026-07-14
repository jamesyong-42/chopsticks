#!/usr/bin/env node
// Bundle the workbench: CommonJS main (the Electron main entry; the ESM-only
// avocado SDK is inlined into it), CJS sandboxed preload, and a browser renderer
// with its CSS sidecar. The pty-host is NOT bundled — it runs from src/ under
// tsx so it can import workspace TS (and the avocado SDK's ESM) directly.

import { build } from 'esbuild';
import { cp, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const shared = { bundle: true, sourcemap: true, logLevel: 'info' };

await mkdir(dist, { recursive: true });

// Ship avocado's JetBrains Mono Nerd Font set next to the renderer so restty's
// Ghostty-parity loader can fetch them under CSP connect-src 'self'.
// pnpm may nest the package; follow the symlink under node_modules.
const avocadoFontCandidates = [
  join(root, 'node_modules', '@vibecook', 'avocado-sdk', 'assets', 'fonts'),
];
try {
  const linked = await realpath(join(root, 'node_modules', '@vibecook', 'avocado-sdk'));
  avocadoFontCandidates.push(join(linked, 'assets', 'fonts'));
} catch {
  /* not linked */
}
const avocadoFonts = avocadoFontCandidates.find((p) => existsSync(p));
if (!avocadoFonts) {
  throw new Error(`avocado fonts not found; tried:\n${avocadoFontCandidates.join('\n')}`);
}
const distFonts = join(dist, 'fonts');
await mkdir(distFonts, { recursive: true });
for (const name of await readdir(avocadoFonts)) {
  if (name.endsWith('.ttf')) await cp(join(avocadoFonts, name), join(distFonts, name));
}

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
  // Renderer: React + avocado VirtualTerminal (engine=restty) + CSS.
  // avocado's Ghostty-parity font loader tries Vite `*.ttf?url` then
  // `new URL(.../assets/fonts/..., import.meta.url)`. Rewrite both to the
  // fonts/ we copied into dist/ so fetch works under Electron file:// + CSP.
  build({
    ...shared,
    entryPoints: [join(root, 'src/renderer/main.tsx')],
    outdir: dist,
    entryNames: 'renderer',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    splitting: true,
    plugins: [
      {
        name: 'avocado-fonts-to-dist',
        setup(buildApi) {
          buildApi.onResolve({ filter: /\.ttf(\?url)?$/ }, (args) => {
            const file = args.path.replace(/^.*\//, '').replace(/\?url$/, '');
            return { path: file, namespace: 'avocado-font' };
          });
          // Emit absolute file:// (or http) URL via import.meta.url so avocado's
          // fetch(url) resolves next to the chunk in dist/, not a broken
          // ../../assets path. Font files themselves are copied to dist/fonts/.
          buildApi.onLoad({ filter: /.*/, namespace: 'avocado-font' }, (args) => ({
            contents: `export default new URL(${JSON.stringify(`./fonts/${args.path}`)}, import.meta.url).href;`,
            loader: 'js',
          }));
        },
      },
    ],
  }),
]);

await cp(join(root, 'src/renderer/index.html'), join(dist, 'index.html'));
// Touch a marker so `ls dist` after a failed build is unambiguous.
await writeFile(join(dist, '.built'), new Date().toISOString());
