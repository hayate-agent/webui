import { readdir, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { historyPage } from './history-page.mjs';

/** Read-only compatibility for already-running pre-pagination connectors.
 * No SessionManager, migration or write access. Only configured roots are read.
 * Keep one bounded parsed source, invalidated by file identity/size/mtime.
 */
export class NativeHistoryReader {
 constructor(roots) { this.roots = roots; this.cache = undefined; }
 async page(id, cwd, before) {
  const loaded = await this.load(id, cwd);
  return loaded ? historyPage(loaded.entries, loaded.leafId, before) : null;
 }
 /** Bounded, read-only: one image block of one message, never the whole file in a response. */
 async entries(id, cwd) { return (await this.load(id, cwd))?.entries ?? null; }
 async load(id, cwd) {
  for (const configured of this.roots) {
   const root = await realpath(configured);
   const visit = async (directory, depth) => {
    if (depth > 2) return;
    for (const item of await readdir(directory, { withFileTypes: true })) {
     if (item.isSymbolicLink()) continue;
     const candidate = path.join(directory, item.name);
     if (item.isDirectory()) { const found = await visit(candidate, depth + 1); if (found) return found; continue; }
     if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
     // Native filenames include the session UUID. Header validation below is
     // authoritative; filename filtering only avoids scanning unrelated content.
     if (!item.name.includes(id)) continue;
     const file = await realpath(candidate), relative = path.relative(root, file);
     if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
     const handle = await open(file, 'r');
     try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw Error('Native history exceeds compatibility read budget');
      const key = `${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      if (this.cache?.key === key && this.cache.id === id && this.cache.cwd === cwd) return { entries: this.cache.entries, leafId: this.cache.leafId };
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      const lines = bytes.subarray(0, offset).toString('utf8').split('\n'), records = [];
      for (let i = 0; i < lines.length; i++) {
       if (!lines[i].trim()) continue;
       try { records.push(JSON.parse(lines[i])); } catch (error) { if (i !== lines.length - 1) throw error; }
      }
      const header = records.shift();
      if (header?.type !== 'session' || header.id !== id || header.cwd !== cwd || ![2, 3].includes(header.version)) continue;
      const entries = records.filter(entry => typeof entry.id === 'string');
      const leafId = entries.at(-1)?.id;
      this.cache = { key, id, cwd, entries, leafId };
      return { entries, leafId };
     } finally { await handle.close(); }
    }
   };
   const found = await visit(root, 0); if (found) return found;
  }
  return null;
 }
}
