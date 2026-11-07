import { useSyncExternalStore } from 'react';

export type ThemeSetting = 'system' | 'light' | 'dark';

const KEY = 'afterlink.theme';

function read(): ThemeSetting {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function apply(setting: ThemeSetting) {
  const root = document.documentElement;
  if (setting === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', setting);
}

const listeners = new Set<() => void>();
let current = read();

/** Applies the saved theme and follows changes made in other frames of the same origin. */
export function initTheme() {
  apply(current);
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    current = read();
    apply(current);
    listeners.forEach((fn) => fn());
  });
}

export function setTheme(setting: ThemeSetting) {
  current = setting;
  try {
    if (setting === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, setting);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  apply(setting);
  listeners.forEach((fn) => fn());
}

export function useTheme(): [ThemeSetting, (setting: ThemeSetting) => void] {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
  return [value, setTheme];
}
