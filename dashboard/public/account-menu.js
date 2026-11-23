// Profile button with a sub-menu (Account settings, Sign out), shown at the right of the page header.
// Replaces the two buttons that used to sit at the foot of the sidebar.
import { openActionMenu } from './ui/menu.jsx';
import { iconButtonClass } from './ui/button-class.js';
import { accountSettings, signOut, hasAccount } from './auth-client.js';

const SVG = 'http://www.w3.org/2000/svg';
function icon() {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const head = document.createElementNS(SVG, 'circle'); head.setAttribute('cx', '12'); head.setAttribute('cy', '8'); head.setAttribute('r', '4');
  const shoulders = document.createElementNS(SVG, 'path'); shoulders.setAttribute('d', 'M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5');
  svg.append(head, shoulders); return svg;
}
/** Returns the profile button, or undefined when the deployment has no sign-in (nothing to manage). */
export function createAccountMenu(notice) {
  if (!hasAccount()) return undefined;
  const button = document.createElement('button'); button.type = 'button'; button.id = 'account-menu';
  button.className = iconButtonClass; button.title = 'Account'; button.setAttribute('aria-label', 'Account'); button.setAttribute('aria-haspopup', 'menu');
  button.append(icon());
  button.onclick = () => openActionMenu(button, [['Account settings', accountSettings], ['Sign out', signOut]], error => notice(error.message), undefined, 'end');
  return button;
}
