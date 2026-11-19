import { compile } from '@tailwindcss/node';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
const candidates = new Set();
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scan(file);
    else if (/\.[jt]sx?$/.test(file)) for (const token of (await readFile(file, 'utf8')).split(/[\s"'`<>={}]+/)) candidates.add(token);
  }
}
await scan('dashboard/public/ui');
const compiler = await compile(await readFile('dashboard/public/components.css', 'utf8'), { base: resolve('dashboard/public'), onDependency() {} });
await writeFile('dist/public/components.css', compiler.build([...candidates]));
await build({ entryPoints: ['dashboard/public/app.js'], bundle: true, jsx: 'automatic', format: 'esm', minify: true, outfile: 'dist/public/app.js' });
await copyFile('dashboard/public/index.html', 'dist/public/index.html');
// Legacy hand-written CSS lives in its own cascade layer BELOW Tailwind utilities. Unlayered rules
// always beat layered ones, which silently disabled every shadcn utility class on elements the
// legacy sheets also style (measured: radius/border/height stayed legacy). The order statement is
// repeated in each sheet so the layer order is fixed whichever sheet loads first.
for (const file of ['style.css', 'workspace-polish.css', 'chat-output.css', 'chat-surface.css', 'mobile.css']) {
  const css = await readFile('dashboard/public/' + file, 'utf8');
  await writeFile('dist/public/' + file, `@layer legacy, theme, base, components, utilities;\n@layer legacy {\n${css}\n}\n`);
}
