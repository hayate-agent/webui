import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
await build({ entryPoints: ['dashboard/public/app.js'], bundle: true, format: 'esm', minify: true, outfile: 'dist/public/app.js' });
for (const file of ['index.html', 'style.css']) await copyFile('dashboard/public/' + file, 'dist/public/' + file);
