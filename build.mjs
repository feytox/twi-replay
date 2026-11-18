import { cp, mkdir, rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const OUT_DIR = 'dist';

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(`${OUT_DIR}/licenses`, { recursive: true });
await Promise.all([
  cp('manifest.json', `${OUT_DIR}/manifest.json`),
  cp('icons', `${OUT_DIR}/icons`, { recursive: true, filter: (source) => !source.endsWith('.svg') }),
  cp('src/content.css', `${OUT_DIR}/content.css`),
  cp('licenses', `${OUT_DIR}/licenses`, { recursive: true }),
  cp('node_modules/hls.js/LICENSE', `${OUT_DIR}/licenses/hls.js.txt`),
]);

const options = {
  entryPoints: ['src/main.ts'],
  outfile: `${OUT_DIR}/content.js`,
  bundle: true,
  format: 'iife',
  target: ['chrome111', 'firefox142'],
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
