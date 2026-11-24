// Per-operator WebUI preferences (hidden sidebar items, palette, light/dark mode, page and header title).
// The SERVER is the source of truth (GET/POST /api/preferences) so every browser of the operator sees the same;
// localStorage is only a cache for the first paint and the fallback when the backend has no such route yet.
import { paletteIds, DEFAULT_PALETTE } from './palettes.js';

export const CACHE_KEY = 'hayate.webui.preferences';
export const LEGACY_HIDDEN_KEY = 'workspace.hidden-agents', LEGACY_THEME_KEY = 'hayate.webui.theme';
export const MODES = ['system', 'light', 'dark'];
export const MAX_TITLE = 60, MAX_HIDDEN = 2000;
// The same shapes the server accepts: a bare agent id, or `project:<agent>:<id>` / `chat:<agent>:<id>`.
export const validKey = key => typeof key === 'string' && /^(?:(?:project|chat):[^\s:]{1,200}:\S{1,200}|[^\s:]{1,200})$/.test(key);
export const DEFAULTS = Object.freeze({ theme: DEFAULT_PALETTE, mode: 'system', pageTitle: '', headerTitle: '', hidden: [], revision: 0 });

const cleanTitle = value => typeof value === 'string' && value.length <= MAX_TITLE && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
/** Only values this browser understands; anything else falls back to the default (a stale cache must never break the page). */
export function sanitize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: paletteIds.includes(value.theme) ? value.theme : DEFAULT_PALETTE,
    mode: MODES.includes(value.mode) ? value.mode : 'system',
    pageTitle: cleanTitle(value.pageTitle), headerTitle: cleanTitle(value.headerTitle),
    hidden: Array.isArray(value.hidden) ? [...new Set(value.hidden.filter(validKey))].slice(0, MAX_HIDDEN).sort() : [],
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
  };
}
/** The same patch semantics as the server: scalars replace, `hide`/`show` change single items (hide wins over show). */
export function applyLocal(current, patch) {
  const next = { ...current, hidden: [...current.hidden] };
  for (const key of ['theme', 'mode', 'pageTitle', 'headerTitle']) if (patch[key] !== undefined) next[key] = patch[key];
  const hidden = new Set(next.hidden); for (const key of patch.show ?? []) hidden.delete(key); for (const key of patch.hide ?? []) hidden.add(key);
  next.hidden = [...hidden].sort(); return sanitize(next);
}

export function createPreferences({ fetch: call, storage }) {
  let value = sanitize(undefined), serverBacked = false; const listeners = new Set();
  const store = () => { try { return storage?.() ?? undefined; } catch { return undefined; } };
  const emit = () => { for (const listener of listeners) listener(value); };
  const cache = () => { try { store()?.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* A full or blocked cache only costs the first-paint shortcut. */ } };
  try { const saved = store()?.getItem(CACHE_KEY); if (saved) value = sanitize(JSON.parse(saved)); } catch { /* Damaged cache: defaults. */ }
  const post = async patch => {
    const response = await call('/api/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1' }, body: JSON.stringify(patch) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(body.error || `Preferences could not be saved (HTTP ${response.status})`), { status: response.status });
    return sanitize(body);
  };
  function legacy() {
    const s = store(); if (!s) return { hidden: [], mode: undefined };
    let hidden = []; try { const saved = JSON.parse(s.getItem(LEGACY_HIDDEN_KEY) ?? '[]'); if (Array.isArray(saved)) hidden = saved.filter(validKey).slice(0, MAX_HIDDEN); } catch { /* Ignore. */ }
    const mode = s.getItem(LEGACY_THEME_KEY); return { hidden, mode: ['light', 'dark'].includes(mode) ? mode : undefined };
  }
  const forgetLegacy = () => { try { store()?.removeItem(LEGACY_HIDDEN_KEY); store()?.removeItem(LEGACY_THEME_KEY); } catch { /* Ignore. */ } };
  return {
    get value() { return value; }, get serverBacked() { return serverBacked; },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isHidden: key => value.hidden.includes(key),
    /** Reads the server record. Without a usable backend route the cached/local values stay in charge. */
    async load() {
      let response; try { response = await call('/api/preferences'); } catch { return value; }
      if (!response.ok) return value;
      let server; try { server = sanitize(await response.json()); } catch { return value; }
      serverBacked = true; value = server;
      // One-time migration of what this browser stored before preferences lived on the server: hidden items are added (never
      // replace the server list); the old light/dark choice is only taken while the server still has the untouched defaults.
      const old = legacy(), patch = {};
      const missing = old.hidden.filter(key => !value.hidden.includes(key)); if (missing.length) patch.hide = missing;
      if (old.mode && value.revision === 0) patch.mode = old.mode;
      if (Object.keys(patch).length) { try { value = await post(patch); forgetLegacy(); } catch { /* Keep the old keys; the next start tries again. */ } }
      else forgetLegacy();
      cache(); emit(); return value;
    },
    /** Optimistic: applied at once, rolled back (and the error thrown) when the server refuses. */
    async update(patch) {
      const before = value; value = applyLocal(value, patch); emit();
      if (!serverBacked) { cache(); return value; }
      try { value = await post(patch); } catch (error) { value = before; emit(); throw error; }
      cache(); emit(); return value;
    },
  };
}

/** Puts the preferences on the page. `fallbackTitle` is the title the page has without a custom one. */
export function applyToPage(prefs, { fallbackTitle = 'Hayate · WebUI', serverMode } = {}) {
  const body = document.body;
  body.dataset.palette = prefs.theme;
  const mode = prefs.mode !== 'system' ? prefs.mode : serverMode && serverMode !== 'system' ? serverMode : 'system';
  if (mode === 'system') delete body.dataset.theme; else body.dataset.theme = mode;
  document.title = prefs.pageTitle || fallbackTitle;
  const name = document.getElementById('brand-name'); if (name) name.textContent = prefs.headerTitle || 'hayate';
}

export const preferences = createPreferences({ fetch: (...args) => fetch(...args), storage: () => globalThis.localStorage });
