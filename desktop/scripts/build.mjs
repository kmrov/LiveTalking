import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const renderer = join(root, 'renderer');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  copyFile(join(renderer, 'studio.html'), join(dist, 'studio.html')),
  copyFile(join(renderer, 'studio.css'), join(dist, 'studio.css')),
  copyFile(join(renderer, 'pcm-worklet.js'), join(dist, 'pcm-worklet.js')),
]);
await build({
  entryPoints: [join(renderer, 'studio.mjs')],
  outfile: join(dist, 'studio.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome130',
  sourcemap: false,
});
