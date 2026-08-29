import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'src');
const dist = join(root, 'dist');

await mkdir(join(dist, 'renderer'), { recursive: true });
await mkdir(join(dist, 'main'), { recursive: true });

// Renderer bundle (browser context) — self-contained IIFE.
await build({
  entryPoints: [join(src, 'renderer', 'main.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: true,
  outfile: join(dist, 'renderer', 'renderer.js'),
  logLevel: 'info',
});

// Resume-pill bundle (browser context).
await build({
  entryPoints: [join(src, 'renderer', 'resume.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: true,
  outfile: join(dist, 'renderer', 'resume.js'),
  logLevel: 'info',
});

// Preload (Node/Electron isolated context) — CommonJS, electron external.
await build({
  entryPoints: [join(src, 'main', 'preload.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node18'],
  external: ['electron'],
  sourcemap: true,
  outfile: join(dist, 'main', 'preload.cjs'),
  logLevel: 'info',
});

// Static assets.
await cp(join(src, 'renderer', 'index.html'), join(dist, 'renderer', 'index.html'));
await cp(join(src, 'renderer', 'resume.html'), join(dist, 'renderer', 'resume.html'));
await cp(join(src, 'renderer', 'styles.css'), join(dist, 'renderer', 'styles.css'));

console.log('renderer + preload bundled, assets copied');
