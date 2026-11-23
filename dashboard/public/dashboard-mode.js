// Reads the server-owned dashboard tool switch (see docs/DASHBOARD-TOOLS.md). Anything that goes
// wrong (network error, bad JSON, unknown value) resolves to "strict", never to a looser mode.
import { normalizeMode } from './dashboard-tools.js';

let cached;
export function loadDashboardToolMode(fetcher = fetch) {
  cached ??= fetcher('/dashboard-config.json', { credentials: 'same-origin' })
    .then(response => (response.ok ? response.json() : {}))
    .then(config => normalizeMode(config?.tools))
    .catch(() => 'strict');
  return cached;
}
export function resetDashboardToolMode() { cached = undefined; }
