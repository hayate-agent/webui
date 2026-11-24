import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PALETTES, DEFAULT_PALETTE, paletteIds } from '../dashboard/public/palettes.js';
import { themesCss } from '../scripts/themes-css.mjs';

const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const KEYS = ['bg', 'panel', 'text', 'muted', 'line', 'accent', 'user', 'danger'];

test('the palettes: green stays the original and comes first, then blue, gray, red and more calm ones', () => {
  assert.deepEqual(paletteIds.slice(0, 4), ['green', 'blue', 'gray', 'red']); assert.ok(paletteIds.length >= 6);
  assert.equal(DEFAULT_PALETTE, 'green'); assert.equal(new Set(paletteIds).size, paletteIds.length);
  const green = PALETTES[0];
  assert.deepEqual(green.light, { bg: '#fafaf8', panel: '#f0f1ed', text: '#252c29', muted: '#637069', line: '#d9dfd9', accent: '#266453', user: '#e8eee9', danger: '#a63232' }, 'the original light colours');
  assert.deepEqual(green.dark, { bg: '#171b19', panel: '#1d2420', text: '#e0e7e1', muted: '#9faea4', line: '#35423a', accent: '#98ceaf', user: '#25382d', danger: '#ffaaaa' }, 'the original dark colours');
});

// The server (plugins/dashboard-api/preferences.mjs THEMES) refuses ids it does not know. This list is a copy of it: when a palette is
// added or removed on one side, this test fails until the other side follows (the id list in the plugin has its own test).
test('the palette ids are exactly the ones the server accepts', () => {
  assert.deepEqual(paletteIds, ['green', 'blue', 'gray', 'red', 'violet', 'sand', 'slate', 'rose']);
});

test('every palette has all eight colours, light and dark, as valid hex', () => {
  for (const palette of PALETTES) for (const mode of ['light', 'dark']) {
    assert.deepEqual(Object.keys(palette[mode]), KEYS, `${palette.id} ${mode}`);
    for (const value of Object.values(palette[mode])) assert.match(value, /^#[0-9a-f]{6}$/, `${palette.id} ${mode}`);
  }
});

test('every palette keeps text, muted text, accent and danger readable (WCAG AA 4.5:1) on every surface it is used on', () => {
  for (const palette of PALETTES) for (const mode of ['light', 'dark']) {
    const c = palette[mode], id = `${palette.id} ${mode}`;
    for (const surface of ['bg', 'panel', 'user']) assert.ok(contrast(c.text, c[surface]) >= 4.5, `${id}: text on ${surface}`);
    for (const surface of ['bg', 'panel']) for (const ink of ['muted', 'accent', 'danger']) assert.ok(contrast(c[ink], c[surface]) >= 4.5, `${id}: ${ink} on ${surface}`);
    assert.ok(contrast(c.bg, c.accent) >= 4.5, `${id}: page colour on an accent button`);
    assert.ok(contrast(c.line, c.bg) > 1.05, `${id}: separators are visible`);
    assert.notEqual(c.bg, c.panel, `${id}: the sidebar differs from the page`);
  }
});

test('the generated stylesheet: light colours per palette, dark by explicit mode and by system setting, nothing inline', () => {
  const css = themesCss();
  for (const palette of PALETTES) {
    const all = colours => `--bg:${colours.bg};--panel:${colours.panel};--text:${colours.text};--muted:${colours.muted};--line:${colours.line};--accent:${colours.accent};--user:${colours.user};--danger:${colours.danger}`;
    assert.ok(css.includes(`[data-palette=${palette.id}]{${all(palette.light)}}`), `${palette.id} light`);
    if (palette.id === DEFAULT_PALETTE) { assert.ok(!css.includes(`body[data-palette=${DEFAULT_PALETTE}]`), 'green dark stays with style.css'); continue; }
    assert.ok(css.includes(`body[data-palette=${palette.id}][data-theme=dark]{${all(palette.dark)};color-scheme:dark}`), `${palette.id} dark by choice`);
    assert.ok(css.includes(`@media(prefers-color-scheme:dark){body[data-palette=${palette.id}]:not([data-theme=light]){${all(palette.dark)}}}`), `${palette.id} dark by system`);
  }
  assert.ok(!/style=|<|javascript:|expression\(/i.test(css));
});

test('the build ships themes.css, the page links it after style.css and the server serves it', async () => {
  const built = await readFile(new URL('../dist/public/themes.css', import.meta.url), 'utf8');
  assert.ok(built.includes('[data-palette=blue]')); assert.ok(built.startsWith('@layer legacy'), 'same layer as the other legacy sheets');
  const html = await readFile(new URL('../dashboard/public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/style.css') < html.indexOf('/themes.css') && html.indexOf('/themes.css') < html.indexOf('/workspace-polish.css'));
  assert.match(await readFile(new URL('../server/server.mjs', import.meta.url), 'utf8'), /'\/themes\.css': \['themes\.css', 'text\/css'\]/);
});
