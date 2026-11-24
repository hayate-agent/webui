// The WebUI colour palettes: the single source for the generated themes.css and the Appearance dialog.
// `green` is the original look and is what the page's own stylesheet already defines; every other palette is
// generated into themes.css by scripts/build.mjs. Ids must match the server's allow-list (dashboard-api preferences.mjs).
// Each palette has the eight colours the stylesheet uses, for light and for dark; test/themes.test.mjs holds every pair to
// WCAG AA contrast (4.5:1 for text, accent and danger colours).
export const PALETTES = [
  { id: 'green', label: 'Green',
    light: { bg: '#fafaf8', panel: '#f0f1ed', text: '#252c29', muted: '#637069', line: '#d9dfd9', accent: '#266453', user: '#e8eee9', danger: '#a63232' },
    dark: { bg: '#171b19', panel: '#1d2420', text: '#e0e7e1', muted: '#9faea4', line: '#35423a', accent: '#98ceaf', user: '#25382d', danger: '#ffaaaa' } },
  { id: 'blue', label: 'Blue',
    light: { bg: '#f8f9fb', panel: '#eef1f6', text: '#1f2733', muted: '#596779', line: '#d8dee8', accent: '#2f5d9e', user: '#e3eaf5', danger: '#a63232' },
    dark: { bg: '#151a21', panel: '#1b222c', text: '#dfe5ee', muted: '#9aa8ba', line: '#333f4f', accent: '#8db4ea', user: '#243248', danger: '#ffaaaa' } },
  { id: 'gray', label: 'Gray',
    light: { bg: '#fafafa', panel: '#f0f0f0', text: '#262626', muted: '#636363', line: '#dcdcdc', accent: '#404040', user: '#e6e6e6', danger: '#a63232' },
    dark: { bg: '#181818', panel: '#202020', text: '#e4e4e4', muted: '#a0a0a0', line: '#3a3a3a', accent: '#cfcfcf', user: '#2b2b2b', danger: '#ffaaaa' } },
  { id: 'red', label: 'Red',
    light: { bg: '#fbf8f7', panel: '#f4ecea', text: '#2d2423', muted: '#705d5a', line: '#e6d8d5', accent: '#9c3a34', user: '#f1e0dd', danger: '#8a1f1f' },
    dark: { bg: '#1c1615', panel: '#251c1b', text: '#ebdfdd', muted: '#b3a09d', line: '#4a3633', accent: '#e8a39d', user: '#3a2624', danger: '#ffb3ad' } },
  { id: 'violet', label: 'Violet',
    light: { bg: '#faf9fc', panel: '#f0eef6', text: '#272431', muted: '#645b76', line: '#dedaea', accent: '#5b4b9a', user: '#e7e3f3', danger: '#a63232' },
    dark: { bg: '#19171f', panel: '#211e29', text: '#e3e0ec', muted: '#a39cb5', line: '#3b3649', accent: '#b5a6ee', user: '#2d2840', danger: '#ffaaaa' } },
  { id: 'sand', label: 'Sand',
    light: { bg: '#fbf9f4', panel: '#f2eee4', text: '#2b2820', muted: '#6b6453', line: '#e2dccb', accent: '#7a5c1e', user: '#ece4d0', danger: '#a63232' },
    dark: { bg: '#1a1813', panel: '#221f18', text: '#e8e3d4', muted: '#aca38d', line: '#3f3a2c', accent: '#d9b76b', user: '#332e20', danger: '#ffaaaa' } },
  { id: 'slate', label: 'Slate',
    light: { bg: '#f7f9fa', panel: '#ecf0f2', text: '#1f2a30', muted: '#566872', line: '#d5dde1', accent: '#2c6a7a', user: '#dde8ec', danger: '#a63232' },
    dark: { bg: '#14191c', panel: '#1a2125', text: '#dde6ea', muted: '#96a8b1', line: '#303d44', accent: '#7cc0d2', user: '#22313a', danger: '#ffaaaa' } },
  { id: 'rose', label: 'Rose',
    light: { bg: '#fcf8f9', panel: '#f6ecef', text: '#2e2327', muted: '#725a63', line: '#ead7dd', accent: '#a23a63', user: '#f3e0e7', danger: '#8a1f1f' },
    dark: { bg: '#1d1619', panel: '#261c20', text: '#ece0e4', muted: '#b5a0a8', line: '#4b3640', accent: '#ee9fbb', user: '#3b2530', danger: '#ffb3c0' } },
];
export const DEFAULT_PALETTE = 'green';
export const paletteIds = PALETTES.map(palette => palette.id);
