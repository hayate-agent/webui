import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import CodeBlock from './beautiful/CodeBlock';
const roots = new Set();
export function mountBeautifulCode(pre, language) {
  const code = pre.querySelector('code');
  const text = code?.textContent ?? pre.textContent;
  const host = document.createElement('div'); host.className = 'bui-code-block';
  pre.replaceWith(host);
  const root = createRoot(host); roots.add({ host, root });
  flushSync(() => root.render(<CodeBlock filename={language || 'Code'} lines={text.replace(/\n$/, '').split('\n')} />));
}
// Release roots only after their markdown host is removed by conversation updates.
let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return; scheduled = true;
  queueMicrotask(() => { scheduled = false; for (const item of roots) if (!item.host.isConnected) { item.root.unmount(); roots.delete(item); } });
}).observe(document.documentElement, { childList: true, subtree: true });
