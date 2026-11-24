import { PALETTES, DEFAULT_PALETTE } from '../dashboard/public/palettes.js';

const names = { bg: '--bg', panel: '--panel', text: '--text', muted: '--muted', line: '--line', accent: '--accent', user: '--user', danger: '--danger' };
const declarations = colours => Object.entries(names).map(([key, variable]) => `${variable}:${colours[key]}`).join(';');

/** CSS for every palette. Light colours sit on `[data-palette=id]` (so a swatch can preview any palette); the dark set follows an
 *  explicit `data-theme=dark` or, without an explicit choice, the system setting - mirroring how style.css treats the original green. */
export function themesCss(palettes = PALETTES) {
  const rules = [];
  for (const palette of palettes) {
    rules.push(`[data-palette=${palette.id}]{${declarations(palette.light)}}`);
    if (palette.id === DEFAULT_PALETTE) continue; // style.css owns the original dark colours
    rules.push(`body[data-palette=${palette.id}][data-theme=dark]{${declarations(palette.dark)};color-scheme:dark}`);
    rules.push(`@media(prefers-color-scheme:dark){body[data-palette=${palette.id}]:not([data-theme=light]){${declarations(palette.dark)}}}`);
  }
  rules.push(`.brand b{font-weight:inherit}`);
  rules.push(`.appearance{display:grid;gap:16px;min-width:min(420px,80vw)}.appearance h3{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}`);
  rules.push(`.appearance .choices{display:flex;flex-wrap:wrap;gap:8px}.appearance .choices>button{display:inline-flex;align-items:center;gap:8px}`);
  rules.push(`.appearance [aria-pressed=true]{background:var(--user);border-color:var(--accent)}`);
  rules.push(`.palette-swatch{display:inline-block;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);background:linear-gradient(90deg,var(--bg) 0 50%,var(--accent) 50% 100%)}`);
  rules.push(`.appearance label{display:grid;gap:5px}.appearance .hint{margin:0;font-size:13px;color:var(--muted)}`);
  return rules.join('\n') + '\n';
}
