"use client";

/* ------------------------------------------------------------------ *
 * THEME APPLICATION (browser only)
 * The engine module owns what a theme *is*; this file owns the edge to
 * the DOM: custom properties on <html>, the colour-scheme hint, the
 * persisted choice, and the boot script that paints before first paint.
 * ------------------------------------------------------------------ */

import { themeCssVars, type Theme } from "@/engine/themes";

export const THEME_STORAGE_KEY = "simplayz.theme.v1";

/** what we persist; the generated palette is stored so a reload is stable */
export interface StoredThemeState {
  themeId: string;
  mapStyle: "cartographer" | "themed";
  customGround: string;
  customAccent: string;
  /** resolved colours for the generated themes, so chaos survives a reload */
  chaosColors?: Theme["colors"];
  chaosGlow?: readonly [string, string];
  /**
   * The resolved custom properties of the last painted theme. The boot
   * script in layout.tsx writes these before React mounts, which is the
   * only way to avoid a theme flash without duplicating the derivation
   * logic (derive/contrast/generate all live in the engine).
   */
  tokens?: Record<string, string>;
}

export const DEFAULT_STORED_THEME: StoredThemeState = {
  themeId: "cartographer",
  mapStyle: "cartographer",
  customGround: "#0e0a1a",
  customAccent: "#c4a6ff",
};

export function readStoredTheme(): StoredThemeState {
  if (typeof window === "undefined") return DEFAULT_STORED_THEME;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_STORED_THEME;
    const parsed = JSON.parse(raw) as Partial<StoredThemeState>;
    return {
      themeId: typeof parsed.themeId === "string" ? parsed.themeId : DEFAULT_STORED_THEME.themeId,
      mapStyle: parsed.mapStyle === "themed" ? "themed" : "cartographer",
      customGround: /^#[0-9a-f]{6}$/i.test(parsed.customGround ?? "") ? parsed.customGround! : DEFAULT_STORED_THEME.customGround,
      customAccent: /^#[0-9a-f]{6}$/i.test(parsed.customAccent ?? "") ? parsed.customAccent! : DEFAULT_STORED_THEME.customAccent,
      chaosColors: parsed.chaosColors,
      chaosGlow: parsed.chaosGlow,
      tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : undefined,
    };
  } catch {
    return DEFAULT_STORED_THEME;
  }
}

export function writeStoredTheme(state: StoredThemeState) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the theme still applies for this session */
  }
}

/** write a theme's tokens to the document root */
export function applyThemeVars(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(themeCssVars(theme))) {
    root.style.setProperty(key, value);
  }
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.colors.scheme;
  root.style.colorScheme = theme.colors.scheme;
}

/** the custom properties for a theme, ready to persist for the boot script */
export function snapshotThemeVars(theme: Theme): Record<string, string> {
  return themeCssVars(theme);
}

/** map style is a separate axis from the UI theme (colour-as-data vs themed map) */
export function applyMapStyle(style: "cartographer" | "themed") {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.map = style;
}
