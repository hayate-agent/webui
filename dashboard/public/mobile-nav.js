// Mobile navigation drawer: below 760px the conversation list is an off-canvas
// panel, so the chat always owns the full screen. Desktop layout is untouched.
// Idempotent: every header (legacy or workspace) gets exactly one toggle, and the
// document-level listeners are installed once.
import { navToggleClass } from './ui/button-class.js';

const query = window.matchMedia('(max-width: 760px)');
// Anything that navigates (conversation, project, agent, "new chat") closes the drawer;
// expanding a project (summary chevron) and the per-item menus (⋮) keep it open.
const closers = '#new, #chats button, .workspace-stream-row > button:first-child, .workspace-agent-heading, .workspace-agent-heading-row > button:nth-child(2), .workspace-tree summary > button:first-child, .workspace-activity-item';
const toggles = new Set();
let installed = false;

const isOpen = () => document.body.hasAttribute('data-nav-open');
function sync(open) {
  document.body.toggleAttribute('data-nav-open', open);
  for (const toggle of toggles) toggle.setAttribute('aria-expanded', String(open));
}

function install() {
  installed = true;
  const aside = document.querySelector('aside'); aside.id = 'conversation-drawer';
  aside.addEventListener('click', event => { if (query.matches && event.target.closest(closers)) sync(false); });
  document.addEventListener('click', event => { if (isOpen() && !event.target.closest('aside, .nav-toggle, .workspace-menu')) sync(false); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    sync(false); [...toggles].find(toggle => toggle.offsetParent)?.focus();
  });
  query.addEventListener('change', () => sync(false));
}

export function setupMobileNavigation(headers) {
  if (!installed) install();
  for (const header of headers) {
    if (!header || header.querySelector(':scope > .nav-toggle')) continue;
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = `nav-toggle ${navToggleClass}`;
    toggle.setAttribute('aria-label', 'Conversations'); toggle.setAttribute('aria-controls', 'conversation-drawer'); toggle.setAttribute('aria-expanded', String(isOpen()));
    toggle.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
    toggle.onclick = event => { event.stopPropagation(); sync(!isOpen()); };
    toggles.add(toggle); header.prepend(toggle);
  }
}
