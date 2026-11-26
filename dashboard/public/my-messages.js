import { openWorkspaceDialog } from './ui/dialog.jsx';
import { styleControl } from './ui/control-class.js';

// Quick access to the messages the operator sent in the open chat.
// `messages` is what the browser holds (bounded); older ones are fetched on demand
// through `loadEarlier`, never rendered all at once.
export const PREVIEW_LENGTH = 90;
export function preview(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_LENGTH ? line.slice(0, PREVIEW_LENGTH - 1) + '…' : line || '(image)';
}
export const sentMessages = messages => messages.filter(message => message.role === 'user');

export function openMyMessages({ getMessages, hasEarlier, loadEarlier, jump, copy, fork }) {
  const content = openWorkspaceDialog('My messages', () => {});
  const make = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
  const button = (text, action, className) => { const e = styleControl(make('button', text, className)); e.type = 'button'; e.onclick = action; return e; };
  const status = make('p', '', 'my-messages-status'); status.setAttribute('role', 'status');
  const list = make('ol', undefined, 'my-messages-list');
  const earlier = button('Load earlier messages', async () => { earlier.disabled = true; try { await loadEarlier(); } finally { earlier.disabled = false; show(); } }, 'my-messages-earlier');
  content.append(status, earlier, list);
  function show() {
    const sent = sentMessages(getMessages());
    list.replaceChildren();
    for (const message of sent) {
      const item = make('li', undefined, 'my-messages-item');
      const open = button(preview(message.text), () => { content.close(); jump(message.id); }, 'my-messages-open');
      open.dataset.messageId = message.id;
      if (message.timestamp) { const when = make('time', new Date(message.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }), 'my-messages-time'); open.prepend(when); }
      const copyButton = button('Copy', async () => { await copy(message); copyButton.textContent = 'Copied'; setTimeout(() => { copyButton.textContent = 'Copy'; }, 1200); }, 'my-messages-copy');
      copyButton.setAttribute('aria-label', 'Copy this message');
      item.append(open, copyButton);
      if (fork) {
        const forkButton = button('Fork from here', async () => {
          forkButton.disabled = true;
          try { await fork(message); content.close(); } catch (error) { status.textContent = error?.message || 'The fork failed.'; forkButton.disabled = false; }
        }, 'my-messages-fork');
        forkButton.setAttribute('aria-label', 'Start a new chat from just before this message');
        item.append(forkButton);
      }
      list.append(item);
    }
    status.textContent = sent.length ? `${sent.length} sent message${sent.length === 1 ? '' : 's'} loaded` : 'No sent messages loaded yet.';
    earlier.hidden = !hasEarlier();
  }
  show();
  return content;
}
