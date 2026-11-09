// Bundles the main process and preloads into dist/main. Bundling means the packaged app ships no
// node_modules and workspace packages need no special handling by electron-builder.
import fs from 'node:fs';
import { build } from 'esbuild';

// The relay this build connects to out of the box, so a new laptop needs no setup.
const { defaultRelayUrl = '' } = JSON.parse(fs.readFileSync('package.json', 'utf-8')).qr2win ?? {};

await build({
  entryPoints: ['src/main/index.ts', 'src/main/preload.ts', 'src/main/popup-preload.ts'],
  outdir: 'dist/main',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
  // `ws` optionally loads these native accelerators; it works without them.
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    __DEFAULT_RELAY_URL__: JSON.stringify(defaultRelayUrl),
  },
});
