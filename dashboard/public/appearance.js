// "Appearance" dialog: palette, light/dark mode, page title and the name in the page header.
import { openWorkspaceDialog } from './ui/dialog.jsx';
import { PALETTES } from './palettes.js';
import { preferences, MAX_TITLE } from './preferences.js';
import { styleControl } from './ui/control-class.js';

export function openAppearance(notice = () => {}) {
  openWorkspaceDialog('Appearance', root => {
    const wrap = document.createElement('div'); wrap.className = 'appearance'; root.append(wrap);
    const section = title => { const box = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = title; box.append(heading); wrap.append(box); return box; };
    const fail = error => notice(error.message);
    const choices = (title, items, current, pick) => {
      const box = section(title), row = document.createElement('div'); row.className = 'choices'; box.append(row);
      const buttons = items.map(item => {
        const b = document.createElement('button'); b.type = 'button'; b.dataset.choice = item.id;
        if (item.swatch) { const dot = document.createElement('span'); dot.className = 'palette-swatch'; dot.dataset.palette = item.id; dot.setAttribute('aria-hidden', 'true'); b.append(dot); }
        b.append(item.label); b.onclick = () => pick(item.id).catch(fail); row.append(b); return b;
      });
      const mark = () => { const active = current(); for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.choice === active)); };
      mark(); return mark;
    };
    const marks = [
      choices('Colour theme', PALETTES.map(p => ({ id: p.id, label: p.label, swatch: true })), () => preferences.value.theme, id => preferences.update({ theme: id })),
      choices('Light or dark', [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }], () => preferences.value.mode, id => preferences.update({ mode: id })),
    ];
    const names = section('Names'), form = document.createElement('form'); names.append(form);
    const field = (label, key, placeholder) => {
      const wrapper = document.createElement('label'); wrapper.textContent = label;
      const input = styleControl(document.createElement('input')); input.maxLength = MAX_TITLE; input.placeholder = placeholder; input.value = preferences.value[key]; input.name = key; wrapper.append(input); form.append(wrapper); return input;
    };
    const page = field('Page title (browser tab)', 'pageTitle', 'Hayate · WebUI'), header = field('Name in the page header', 'headerTitle', 'hayate');
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save names'; form.append(save);
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try { await preferences.update({ pageTitle: page.value, headerTitle: header.value }); page.value = preferences.value.pageTitle; header.value = preferences.value.headerTitle; }
      catch (error) { fail(error); } finally { save.disabled = false; }
    };
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = preferences.serverBacked ? 'Stored on the server for your account: every browser you sign in with shows the same.' : 'This server cannot store preferences yet; they apply to this browser only.';
    wrap.append(hint);
    const off = preferences.onChange(() => { for (const mark of marks) mark(); });
    const observer = new MutationObserver(() => { if (!root.isConnected) { off(); observer.disconnect(); } });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
