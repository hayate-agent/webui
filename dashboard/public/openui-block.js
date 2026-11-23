// ```openui fences in assistant messages become live UI. Until the lazily loaded bundle is there
// (or when it fails) the program stays visible as code. Tools: none in this step, so a block can
// show layout and values but a Query/Mutation reports "tool not found" (tool access = later step,
// governed by HAYATE_DASHBOARD_TOOLS, see docs/DASHBOARD-TOOLS.md).
import { loadDashboard } from './dashboard-loader.js';
import { loadDashboardToolMode } from './dashboard-mode.js';
import { getDashboardContext } from './dashboard-context.js';
import { connectDashboardTools } from './dashboard-bridge.js';

export const MAX_LIVE_BLOCKS = 12;
const live = new Set();

export function isOpenUIFence(code) { return /(^|\s)language-openui(\s|$)/.test(code?.className ?? ''); }

function sweep() {
  for (const entry of [...live]) if (!entry.host.isConnected) { entry.handle?.unmount(); live.delete(entry); }
  // The history is virtualized, but never let blocks pile up even if rows stay attached.
  while (live.size > MAX_LIVE_BLOCKS) { const oldest = live.values().next().value; oldest.handle?.unmount(); oldest.host.replaceChildren(oldest.fallback()); live.delete(oldest); }
}

/** Replaces the `<pre>` by a host showing the live block; returns the host. */
export function mountOpenUIBlock(pre, source, { load = loadDashboard, loadMode = loadDashboardToolMode, showCode, connect = connectDashboardTools, confirm = async () => false, audit } = {}) {
  const host = document.createElement('div');
  host.className = 'openui-block'; host.dataset.openui = 'loading';
  // The visible stand-in is the ordinary code block (the caller renders it into `host`).
  const fallback = () => { const holder = document.createElement('div'); showCode?.(holder, source); return holder; };
  pre.replaceWith(host);
  showCode?.(host, source);
  const entry = { host, fallback, handle: undefined };
  const context = getDashboardContext();
  // `off` never even asks the agent which tools it has.
  Promise.all([load(), loadMode().then(async mode => ({ mode, link: mode === 'off' ? { tools: [], call: async () => { throw new Error('tools are off'); } } : await connect(context ?? {}) }))]).then(([bundle, { mode, link }]) => {
    if (!host.isConnected) return;
    sweep();
    const stand = [...host.childNodes];
    host.replaceChildren(); host.dataset.openui = 'live';
    try { entry.handle = bundle.mountDashboard(host, { source, mode, tools: link.tools, call: link.call, confirm, audit,
      onError: errors => { host.dataset.openuiErrors = String(errors?.length ?? 0); } }); }
    catch (error) { host.replaceChildren(...stand); throw error; }
    live.add(entry); sweep();
  }).catch(() => { host.dataset.openui = 'failed'; });
  return host;
}
export function liveBlockCount() { return live.size; }
// Roots of blocks whose message left the page are released at once, not at the next mount.
if (typeof MutationObserver === 'function') {
  let scheduled = false;
  new MutationObserver(() => { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; sweep(); }); }).observe(document.documentElement, { childList: true, subtree: true });
}
