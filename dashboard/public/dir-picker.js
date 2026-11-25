import { openWorkspaceDialog } from './ui/dialog.jsx';
import { styleControl } from './ui/control-class.js';

// Folder picker for a PI working directory. `list(path)` answers { roots } for no path,
// otherwise { directory, parent, entries: [{ name, path }] }. Resolves with the chosen
// directory, or undefined when the dialog is closed without a choice.
export function pickDirectory(list, { title = 'Choose working directory', start } = {}) {
  return new Promise(resolve => {
    let chosen;
    const content = openWorkspaceDialog(title, d => {
      d.append(Object.assign(document.createElement('p'), { textContent: 'Only folders inside the configured roots are shown.' }));
    });
    const make = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
    const button = (text, action, className) => { const e = styleControl(make('button', text, className)); e.type = 'button'; e.onclick = action; return e; };
    const error = make('p', '', 'workspace-error'); error.hidden = true; error.setAttribute('role', 'alert');
    const current = make('p', '', 'dir-picker-current');
    const rows = make('div', undefined, 'dir-picker-list');
    const use = button('Use this folder', () => { if (!current.dataset.path) return; chosen = current.dataset.path; content.close(); resolve(chosen); }, 'dir-picker-use');
    use.disabled = true;
    content.append(error, current, use, rows);
    const watch = setInterval(() => { if (!content.open) { clearInterval(watch); if (chosen === undefined) resolve(undefined); } }, 150);
    async function show(path) {
      error.hidden = true;
      let response;
      try { response = await list(path); } catch (failure) { error.textContent = failure?.message ?? 'Folders could not be read'; error.hidden = false; return; }
      rows.replaceChildren();
      if (response.roots) {
        current.textContent = 'Roots'; delete current.dataset.path; use.disabled = true;
        for (const root of response.roots) rows.append(button(root, () => void show(root), 'dir-picker-row'));
        if (response.roots.length === 1 && !path) await show(response.roots[0]);
        return;
      }
      current.textContent = response.directory; current.dataset.path = response.directory; use.disabled = false;
      rows.append(button('↑ Parent', () => void show(response.parent), 'dir-picker-row dir-picker-parent'));
      rows.lastChild.hidden = !response.parent;
      for (const entry of response.entries) rows.append(button(entry.name + '/', () => void show(entry.path), 'dir-picker-row'));
      if (!response.entries.length) rows.append(make('p', 'No subfolders.', 'dir-picker-empty'));
    }
    void show(start);
  });
}
