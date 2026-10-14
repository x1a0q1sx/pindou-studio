import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const outfile = path.join(root, 'node_modules', '.tmp', 'core-tests.mjs');

await build({
  entryPoints: [path.join(root, 'scripts', 'core-tests.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  outfile,
  alias: {
    '@': path.join(root, 'src'),
  },
  logLevel: 'silent',
});

await import(pathToFileURL(outfile).href);
