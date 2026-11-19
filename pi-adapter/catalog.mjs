import { readdir, realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Read-only discovery. Never opens SessionManager (which may migrate/rewrite).
 * Browser identifiers are opaque; arbitrary paths cannot be requested. */
export class SessionCatalog {
  cache = new Map(); entries = new Map();
  constructor(roots = []) { this.roots = roots; }
  refresh() {
    if (!this.refreshing) this.refreshing = this.scan().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  async scan() {
    // Conservative aggregate input budget; JSON parsing may expand severalfold.
    let budget = 16 * 1024 * 1024;
    const found = new Map();
    for (const configured of this.roots) {
      const root = await realpath(configured);
      const visit = async (directory, depth) => {
        if (depth > 2 || found.size >= 5000) return;
        for (const dirent of await readdir(directory, { withFileTypes: true })) {
          if (found.size >= 5000) break;
          if (dirent.isSymbolicLink()) continue;
          const file = path.join(directory, dirent.name);
          if (dirent.isDirectory()) { await visit(file, depth + 1); continue; }
          if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue;
          try {
            const canonical = await realpath(file), relative = path.relative(root, canonical);
            if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
            const info = await stat(canonical);
            if (info.size > 8 * 1024 * 1024 || info.size > budget) continue;
            budget -= info.size;
            const id = 'disk_' + createHash('sha256').update(canonical).digest('hex').slice(0, 32);
            const cached = this.cache.get(id);
            let item = cached;
            if (!cached || cached.size !== info.size || cached.mtime !== info.mtimeMs) {
              const lines = (await readFile(canonical, 'utf8')).split('\n');
              const records = [];
              for (let i = 0; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                try { records.push(JSON.parse(lines[i])); }
                catch { if (i !== lines.length - 1) throw Error('Invalid session'); }
              }
              const header = records[0];
              if (!header || header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string' || ![1, 2, 3].includes(header.version ?? 1)) continue;
              // Legacy linear sessions require native migration; show metadata
              // but do not invent a parent tree for their transcript.
              const entries = records.slice(1).filter(entry => entry && typeof entry.id === 'string');
              const name = entries.filter(entry => entry.type === 'session_info' && typeof entry.name === 'string').at(-1)?.name;
              item = { id, nativeId: header.id, cwd: header.cwd, name: name ?? 'PI session', owner: 'disk', connected: false, readOnly: true, size: info.size, mtime: info.mtimeMs, entries, leafId: entries.at(-1)?.id ?? null, legacy: (header.version ?? 1) < 2 };
              // Populate the next bounded cache only after the scan completes.
            }
            found.set(id, item);
          } catch { /* A malformed or disappearing file does not break discovery. */ }
        }
      };
      await visit(root, 0);
    }
    this.entries = found;
    this.cache = new Map(found);
    return this.list();
  }
  list() { return [...this.entries.values()].map(({ entries, leafId, size, ...metadata }) => metadata).sort((a, b) => b.mtime - a.mtime); }
  snapshot(id) {
    const item = this.entries.get(id);
    if (!item) throw Error('Session not in allowed catalog');
    return { entries: item.entries, leafId: item.leafId, busy: false, readOnly: true, legacy: item.legacy };
  }
}
