import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeStore {
  theme: ThemeMode;
  resolved: 'light' | 'dark';
  setTheme: (theme: ThemeMode) => void;
  toggle: () => void;
}

function savedTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return 'system';
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  function apply(theme: ThemeMode): 'light' | 'dark' {
    const dark = theme === 'dark' || (theme === 'system' && systemDark.matches);
    document.documentElement.classList.toggle('dark', dark);
    return dark ? 'dark' : 'light';
  }
  const saved = savedTheme();

  systemDark.addEventListener('change', () => {
    if (get().theme === 'system') set({ resolved: apply('system') });
  });

  return {
    theme: saved,
    resolved: apply(saved),
    setTheme: (theme) => {
      try { localStorage.setItem('theme', theme); } catch {}
      set({ theme, resolved: apply(theme) });
    },
    toggle: () => {
      const current = get().resolved;
      get().setTheme(current === 'dark' ? 'light' : 'dark');
    },
  };
});
