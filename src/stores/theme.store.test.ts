import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const initialThemeScript = page.match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>[\s\S]*?<\/head>/)![1];

afterEach(() => {
  localStorage.removeItem('theme');
  vi.unstubAllGlobals();
});

async function openWindow(systemIsDark: boolean) {
  vi.resetModules();
  const system = new EventTarget() as EventTarget & { matches: boolean };
  system.matches = systemIsDark;
  let dark = false;
  const classList = { toggle: (name: string, on: boolean) => { if (name === 'dark') dark = on; } };
  vi.stubGlobal('document', { documentElement: { classList } });
  vi.stubGlobal('window', { matchMedia: () => system });
  runInNewContext(initialThemeScript, { document, localStorage, window });
  const firstPaintDark = dark;
  const { useThemeStore } = await import('./theme.store');
  return { firstPaintDark, isDark: () => dark, store: useThemeStore, system };
}

it.each([
  [null, false, false, 'system'],
  [null, true, true, 'system'],
  ['invalid', true, true, 'system'],
  ['system', false, false, 'system'],
  ['light', true, false, 'light'],
  ['dark', false, true, 'dark'],
] as const)('uses preference %s on a dark=%s system from first paint', async (saved, osDark, expected, mode) => {
  if (saved) localStorage.setItem('theme', saved);
  const ui = await openWindow(osDark);
  expect(ui.firstPaintDark).toBe(expected);
  expect(ui.isDark()).toBe(expected);
  expect(ui.store.getState()).toMatchObject({ theme: mode, resolved: expected ? 'dark' : 'light' });
});

it('follows system changes until a manual choice is saved and restores it on restart', async () => {
  const ui = await openWindow(false);
  ui.system.matches = true;
  ui.system.dispatchEvent(new Event('change'));
  expect(ui.isDark()).toBe(true);
  ui.store.getState().toggle();
  ui.system.matches = false;
  ui.system.dispatchEvent(new Event('change'));
  ui.system.matches = true;
  ui.system.dispatchEvent(new Event('change'));
  expect(ui.isDark()).toBe(false);
  const restarted = await openWindow(true);
  expect(restarted.firstPaintDark).toBe(false);
  expect(restarted.store.getState().theme).toBe('light');
  restarted.store.getState().setTheme('system');
  expect(restarted.isDark()).toBe(true);
});
