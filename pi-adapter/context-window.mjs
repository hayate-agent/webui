import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Resolves a model's context window from PI's own model configuration files
 * (read-only, bounded, cached by file identity). Unknown models yield null: the
 * UI then shows tokens without a percentage instead of guessing. */
const FILES = ['models.json', 'models-store.json', 'homelab-ai-gateway-models.json'];
const MAX_FILE = 4 * 1024 * 1024;

export function createContextWindows({ directory = path.join(homedir(), '.pi', 'agent') } = {}) {
  const cache = new Map();
  async function table(file) {
    const full = path.join(directory, file);
    let info; try { info = await stat(full); } catch { return new Map(); }
    if (!info.isFile() || info.size > MAX_FILE) return new Map();
    const key = `${info.size}:${info.mtimeMs}`, hit = cache.get(file);
    if (hit?.key === key) return hit.map;
    const map = new Map();
    try {
      const walk = (value, name, depth) => {
        if (!value || typeof value !== 'object' || depth > 8) return;
        const window = value.contextWindow;
        if (Number.isFinite(window) && window > 0) {
          const id = typeof value.id === 'string' ? value.id : name;
          if (id) { map.set(id, window); map.set(id.replace(/^homelab\//, ''), window); }
        }
        for (const [childName, child] of Object.entries(value)) walk(child, childName, depth + 1);
      };
      walk(JSON.parse(await readFile(full, 'utf8')), '', 0);
    } catch { /* unreadable configuration: no windows */ }
    cache.set(file, { key, map });
    return map;
  }
  return {
    async resolve(model) {
      if (typeof model !== 'string' || !model) return null;
      for (const file of FILES) { const window = (await table(file)).get(model); if (window) return window; }
      return null;
    },
  };
}
