import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeStore {
  theme: ThemeMode;
  resolved: 'light' | 'dark';
  setTheme: (theme: ThemeMode) => void;
  toggle: () => void;
}

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  return theme === 'system' ? getSystemTheme() : theme;
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  const saved = (localStorage.getItem('theme') as ThemeMode) || 'dark';
  const resolved = resolveTheme(saved);
  document.documentElement.classList.toggle('dark', resolved === 'dark');

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (get().theme === 'system') {
      const r = getSystemTheme();
      document.documentElement.classList.toggle('dark', r === 'dark');
      set({ resolved: r });
    }
  });

  return {
    theme: saved,
    resolved,
    setTheme: (theme) => {
      const resolved = resolveTheme(theme);
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', resolved === 'dark');
      set({ theme, resolved });
    },
    toggle: () => {
      const current = get().resolved;
      get().setTheme(current === 'dark' ? 'light' : 'dark');
    },
  };
});
