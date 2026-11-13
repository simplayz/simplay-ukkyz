"use client";

/* ------------------------------------------------------------------ *
 * THEME STORE — user-selectable appearance, persisted per browser.
 * ------------------------------------------------------------------ *
 * Separate from the world store on purpose: the theme must work on the
 * landing page too, where no world snapshot is loaded, and it must be
 * able to repaint the document without a network round trip.
 *
 * Axes:
 *   theme    cartographer | violet | lilac | custom | chaos
 *   mapStyle cartographer (fixed colour-as-data) | themed (follows theme)
 * ------------------------------------------------------------------ */

import { create } from "zustand";
import {
  BASE_THEMES,
  THEME_CARTOGRAPHER,
  baseTheme,
  deriveCustomTheme,
  randomTheme,
  type MapStyle,
  type Theme,
  type ThemeId,
} from "@/engine/themes";
import { applyMapStyle, applyThemeVars, readStoredTheme, snapshotThemeVars, writeStoredTheme, DEFAULT_STORED_THEME, type StoredThemeState } from "@/lib/theme";

interface ThemeStore {
  themeId: ThemeId;
  mapStyle: MapStyle;
  customGround: string;
  customAccent: string;
  /** resolved theme object currently painted */
  theme: Theme;
  /** increments when chaos re-rolls, for the UI to react */
  roll: number;
  setTheme: (id: ThemeId) => void;
  setMapStyle: (style: MapStyle) => void;
  setCustom: (ground: string, accent: string) => void;
  rerollChaos: () => void;
  hydrate: () => void;
}

const CHAOS_BASE = BASE_THEMES.find((t) => t.id === "chaos") ?? THEME_CARTOGRAPHER;

function resolve(stored: StoredThemeState, roll = 0): Theme {
  switch (stored.themeId) {
    case "violet":
    case "lilac":
    case "cartographer":
      return baseTheme(stored.themeId);
    case "custom":
      return deriveCustomTheme(stored.customGround, stored.customAccent);
    case "chaos": {
      // reuse the persisted roll so a reload does not shuffle the look;
      // a deliberate re-roll (roll > 0) always generates a fresh palette
      const persisted = stored.chaosColors;
      if (persisted && roll === 0) {
        const base = CHAOS_BASE;
        return { ...base, colors: persisted, glow: stored.chaosGlow ?? base.glow };
      }
      return randomTheme();
    }
    default:
      return THEME_CARTOGRAPHER;
  }
}

function persist(state: Pick<ThemeStore, "themeId" | "mapStyle" | "customGround" | "customAccent" | "theme">, roll: number) {
  const next: StoredThemeState = {
    themeId: state.themeId,
    mapStyle: state.mapStyle,
    customGround: state.customGround,
    customAccent: state.customAccent,
    chaosColors: state.themeId === "chaos" ? state.theme.colors : undefined,
    chaosGlow: state.themeId === "chaos" ? state.theme.glow : undefined,
    // resolved custom properties for the pre-hydration boot script
    tokens: snapshotThemeVars(state.theme),
  };
  void roll;
  writeStoredTheme(next);
}

function paint(theme: Theme, mapStyle: MapStyle) {
  applyThemeVars(theme);
  applyMapStyle(mapStyle);
}

export const useTheme = create<ThemeStore>((set, get) => ({
  themeId: "cartographer",
  mapStyle: "cartographer",
  customGround: DEFAULT_STORED_THEME.customGround,
  customAccent: DEFAULT_STORED_THEME.customAccent,
  theme: THEME_CARTOGRAPHER,
  roll: 0,

  hydrate: () => {
    const stored = readStoredTheme();
    const theme = resolve(stored);
    paint(theme, stored.mapStyle);
    set({
      themeId: theme.id,
      mapStyle: stored.mapStyle,
      customGround: stored.customGround,
      customAccent: stored.customAccent,
      theme,
    });
  },

  setTheme: (id) => {
    const state = get();
    const stored: StoredThemeState = {
      themeId: id,
      mapStyle: state.mapStyle,
      customGround: state.customGround,
      customAccent: state.customAccent,
    };
    const theme = id === "chaos" ? randomTheme() : resolve(stored);
    paint(theme, state.mapStyle);
    set({ themeId: id, theme, roll: state.roll + 1 });
    persist({ ...state, themeId: id, theme }, state.roll);
  },

  setMapStyle: (style) => {
    const state = get();
    applyMapStyle(style);
    set({ mapStyle: style });
    persist({ ...state, mapStyle: style }, state.roll);
  },

  setCustom: (ground, accent) => {
    const state = get();
    const theme = deriveCustomTheme(ground, accent);
    paint(theme, state.mapStyle);
    set({ themeId: "custom", customGround: ground, customAccent: accent, theme, roll: state.roll + 1 });
    persist({ ...state, themeId: "custom", customGround: ground, customAccent: accent, theme }, state.roll);
  },

  rerollChaos: () => {
    const state = get();
    const theme = randomTheme();
    paint(theme, state.mapStyle);
    set({ themeId: "chaos", theme, roll: state.roll + 1 });
    persist({ ...state, themeId: "chaos", theme }, state.roll);
  },
}));
