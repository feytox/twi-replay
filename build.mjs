import { cp, mkdir, rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const OUT_DIR = 'dist';

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR);
await Promise.all([
  cp('manifest.json', `${OUT_DIR}/manifest.json`),
  cp('icons', `${OUT_DIR}/icons`, { recursive: true, filter: (source) => !source.endsWith('.svg') }),
  cp('src/content.css', `${OUT_DIR}/content.css`),
]);

const options = {
  entryPoints: ['src/main.ts'],
  outfile: `${OUT_DIR}/content.js`,
  bundle: true,
  format: 'iife',
  target: ['chrome111', 'firefox140'],
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
