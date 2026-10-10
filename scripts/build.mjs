import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });

const options = {
  entryPoints: ['src/background.js', 'src/content.js', 'src/panel.js'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome120',
  sourcemap: false,
};

if (process.argv.includes('--watch')) {
  const compiler = await context(options);
  await compiler.watch();
  console.log('Watching JavaScript. Reload the extension after changes.');
} else {
  await build(options);
}
