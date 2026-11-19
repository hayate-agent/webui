import { mkdir, writeFile, access, realpath, readFile, rename, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function installConnector({ home = homedir(), root = fileURLToPath(new URL('../', import.meta.url)), update = false } = {}) {
 const source = path.join(await realpath(root), 'pi-adapter/extension.mjs');
 await access(source);
 const target = path.join(home, '.pi/agent/extensions/hayate-webui.js');
 await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
 // Deliberately exclusive: never overwrite another connector or local edits.
 // A transitive native .mjs import remains cached across PI /reload even
 // when its Jiti loader disables moduleCache. Bundle into the reloadable .js
 // entry instead; only Node builtins remain external.
 const bundled = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22' });
 const content = `// Generated Hayate WebUI connector bundle from ${JSON.stringify(source)}.\n${bundled.outputFiles[0].text}`;
 if (update) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw Error('Unsafe connector update target');
  const prior = await readFile(target, 'utf8');
  if (!prior.startsWith(`// Generated Hayate WebUI connector bundle from ${JSON.stringify(source)}.\n`)) throw Error('Update requires a generated bundle from this checkout; inspect and back up legacy/custom shims explicitly');
  const temporary = target + '.update-' + process.pid;
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
 } else await writeFile(target, content, { flag: 'wx', mode: 0o600 });
 return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) installConnector({ update: process.argv.includes('--update') }).then(file => console.log(`Installed PI connector: ${file}\nReload PI once to discover the extension.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
