import type { Locale } from "./i18n";

export interface Settings {
  name: string;
  locale: Locale | null;
  cameraId: string | null;
}

const KEY = "bombanana:settings";
const DEFAULTS: Settings = { name: "", locale: null, cameraId: null };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<Settings>): void {
  try {
    const current = loadSettings();
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    /* приватный режим/квота — настройки просто не переживут перезапуск */
  }
}
