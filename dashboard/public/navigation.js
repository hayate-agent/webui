/** Hash navigation: every selection has a stable, shareable address.
 *
 *   #/                       new chat / dashboard
 *   #/agent/<agent>          agent overview
 *   #/chat/<agent>/<chat>    a conversation ("local" for the central agent)
 *   #/project/<agent>/<id>   a project
 *
 * Back/forward and reload restore the selection. The module only parses and
 * writes the hash; the workspace client decides what to open. Writing the hash
 * for a selection that came from the hash itself is suppressed (no loops).
 */
const SEGMENT = /^[A-Za-z0-9_.:-]{1,160}$/;

export function parseRoute(hash) {
  const raw = String(hash ?? '').replace(/^#\/?/, '').replace(/\/$/, '');
  if (!raw) return { kind: 'home' };
  // Empty segments (`//`) are malformed, not skipped.
  const parts = raw.split('/').map(part => { try { return decodeURIComponent(part); } catch { return ''; } });
  if (parts.some(part => !SEGMENT.test(part))) return { kind: 'home' };
  if (parts[0] === 'agent' && parts.length === 2) return { kind: 'agent', agent: parts[1] };
  if (parts[0] === 'chat' && parts.length === 3) return { kind: 'chat', agent: parts[1], id: parts[2] };
  if (parts[0] === 'project' && parts.length === 3) return { kind: 'project', agent: parts[1], id: parts[2] };
  return { kind: 'home' };
}

export function formatRoute(route) {
  const enc = encodeURIComponent;
  if (route.kind === 'agent') return `#/agent/${enc(route.agent)}`;
  if (route.kind === 'chat') return `#/chat/${enc(route.agent)}/${enc(route.id)}`;
  if (route.kind === 'project') return `#/project/${enc(route.agent)}/${enc(route.id)}`;
  return '#/';
}

export function createNavigation({ open, win = window }) {
  let applying = false, current = win.location.hash || '#/';
  const apply = async () => {
    const hash = win.location.hash || '#/';
    if (hash === current && !applying) return;
    current = hash; applying = true;
    try { await open(parseRoute(hash)); } finally { applying = false; }
  };
  win.addEventListener('hashchange', () => { void apply(); });
  return {
    /** Records the current selection in the address bar. */
    show(route) {
      // No loop guard needed: a selection that came from the address formats to the
      // same hash and is a no-op. Selections made by the user while a restore is
      // still loading must reach the address bar.
      const hash = formatRoute(route);
      if ((win.location.hash || '#/') === hash) { current = hash; return; }
      current = hash; win.location.hash = hash;
    },
    /** Opens whatever the address currently names (initial load). */
    async restore() { const route = parseRoute(win.location.hash); if (route.kind !== 'home') { applying = true; try { await open(route); } finally { applying = false; } } },
  };
}
