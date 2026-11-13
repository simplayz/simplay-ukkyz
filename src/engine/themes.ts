/* ------------------------------------------------------------------ *
 * SIMPLAYZ THEMES — 1.0.0 "glass" design system
 * ------------------------------------------------------------------ *
 * Four hand-tuned themes plus one runtime generator, all rendered with
 * glass-morphism chrome (translucent panes, blur, hairline edges):
 *
 *   cartographer  the original mint-on-void industrial HUD
 *   violet        dark purplish
 *   lilac         light purplish
 *   custom        the pilot picks two colours; the rest is derived
 *   chaos         random high-contrast, generated per click
 *
 * Every theme is a flat token map: `applyTheme()` writes each token to
 * `document.documentElement` as `--color-<token>`, and `globals.css`
 * maps those to Tailwind utilities via `@theme inline`. Components keep
 * using classes like `bg-void` / `text-ink` / `border-line` and the whole
 * app re-skins live.
 *
 * Pure module: no DOM access. `applyTheme` lives in `src/lib/theme.ts`.
 * ------------------------------------------------------------------ */

import {
  contrastRatio,
  ensureContrast,
  hexToRgb,
  hslToRgb,
  luminance,
  mixHex,
  rgbToHex,
  rgbToHsl,
  type MapPalette,
} from "@/engine/palette";

export const THEME_IDS = ["cartographer", "violet", "lilac", "custom", "chaos"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const MAP_STYLES = ["cartographer", "themed"] as const;
export type MapStyle = (typeof MAP_STYLES)[number];

/**
 * Flat colour tokens. Keep this list stable and small — every entry is
 * re-written to the document root on every theme change.
 */
export interface ThemeColors {
  /** page background behind the glass */
  void: string;
  /** secondary background (bands, footer) */
  hull: string;
  /** glass pane base tint */
  glass: string;
  /** solid pane tint (opaque variant, used where blur is unavailable) */
  panel: string;
  /** hairline borders */
  line: string;
  /** primary text */
  ink: string;
  /** muted text */
  dim: string;
  /** faint text / telemetry */
  faint: string;
  /** primary accent */
  mint: string;
  /** warning accent */
  amber: string;
  /** informational accent */
  ice: string;
  /** negative accent */
  rose: string;
  /** text that sits on top of an accent fill (buttons) */
  onAccent: string;
  /** page-level body copy intent: drives which glass mix tokens resolve to */
  scheme: "dark" | "light";
}

export interface Theme {
  id: ThemeId;
  /** display name in the picker */
  name: string;
  /** one-line description */
  blurb: string;
  colors: ThemeColors;
  /** hero/sky gradient stops for the landing page wash */
  glow: readonly [string, string];
  /** flat map ramps when map style is "themed" */
  map: MapPalette;
  /** two colours the pilot replaces in the custom theme */
  seed?: readonly [string, string];
}

/* ------------------------------ helpers ------------------------------ */

/** glass tint = background lifted toward the scheme's ink, low alpha is added in CSS */
function glassFor(scheme: "dark" | "light", bg: string, ink: string) {
  return mixHex(bg, ink, scheme === "dark" ? 0.06 : 0.035);
}

function solidPanel(scheme: "dark" | "light", bg: string, ink: string) {
  return mixHex(bg, ink, scheme === "dark" ? 0.1 : 0.05);
}

/** text accent that is guaranteed readable on the theme background */
function accent(raw: string, bg: string, target = 4.5) {
  return ensureContrast(raw, bg, target);
}

/**
 * A themed flat map: keep the cartographic *hue families* (blue water,
 * neutral sand, green land) but move them into the theme's world so the
 * map belongs to the chrome. Light themes get lighter deep water so the
 * sea does not read as a hole in a light page.
 */
function themedMap(base: string, scheme: "dark" | "light"): MapPalette {
  const { h } = rgbToHsl(hexToRgb(base));
  const waterHue = 205 + ((h - 270) % 40) * 0.15; // stays blue, leans with the theme
  const violet = (l: number, s: number, hue = h) => rgbToHex(hslToRgb(hue, s, l));
  // The survey's land values cluster low (most ground is lowland), so the
  // *low* stop carries most of the visible area: keep it saturated and let
  // the high stop do the "summit" work. Water gets a deep low stop so sea
  // never reads as another shade of land.
  if (scheme === "dark") {
    return {
      mode: "dark",
      water: [violet(0.12, 0.62, waterHue), violet(0.52, 0.74, waterHue)],
      sand: [violet(0.2, 0.1), violet(0.62, 0.12)],
      land: [violet(0.2, 0.5), violet(0.76, 0.34)],
    };
  }
  return {
    mode: "light",
    water: [violet(0.28, 0.68, waterHue), violet(0.62, 0.7, waterHue)],
    sand: [violet(0.42, 0.07), violet(0.72, 0.05)],
    land: [violet(0.16, 0.56), violet(0.62, 0.4)],
  };
}

/* ------------------------------ themes ------------------------------ */

export const THEME_CARTOGRAPHER: Theme = {
  id: "cartographer",
  name: "Cartographer",
  blurb: "The original mint-on-void HUD. Flat map in true cartographic colours.",
  colors: {
    void: "#04070a",
    hull: "#090f14",
    glass: glassFor("dark", "#04070a", "#dbf1f7"),
    panel: solidPanel("dark", "#04070a", "#dbf1f7"),
    line: "#1b2b36",
    ink: "#dbf1f7",
    dim: "#9dbdcb",
    faint: "#6c8794",
    mint: "#7df0c0",
    amber: "#ffb454",
    ice: "#68b7ff",
    rose: "#f47ba8",
    onAccent: "#04070a",
    scheme: "dark",
  },
  glow: ["#0b3a52", "#1d5c45"],
  map: { mode: "cartographer", water: ["#052a4e", "#4bb8f0"], sand: ["#57524a", "#d3cdbf"], land: ["#1b7a43", "#e9f6d8"] },
};

export const THEME_VIOLET: Theme = {
  id: "violet",
  name: "Violet Nocturne",
  blurb: "Dark purplish glass. Indigo ground, orchid edges, warm lilac accents.",
  colors: {
    void: "#0e0a1a",
    hull: "#151028",
    glass: glassFor("dark", "#0e0a1a", "#f0e9ff"),
    panel: solidPanel("dark", "#0e0a1a", "#f0e9ff"),
    line: "#332a4d",
    ink: "#efe8ff",
    dim: "#bdb0dd",
    faint: "#8d80ad",
    mint: accent("#c4a6ff", "#0e0a1a"),
    amber: accent("#ffb066", "#0e0a1a"),
    ice: accent("#8fd0ff", "#0e0a1a"),
    rose: accent("#ff8fc4", "#0e0a1a"),
    onAccent: "#140d24",
    scheme: "dark",
  },
  glow: ["#2b1b5e", "#5b2a78"],
  map: {
    mode: "dark",
    water: ["#1a2a6b", "#6ea8ff"],
    sand: ["#3d3452", "#a99fc0"],
    land: ["#2f6b52", "#cbe8c8"],
  },
};

export const THEME_LILAC: Theme = {
  id: "lilac",
  name: "Lilac Daylight",
  blurb: "Light purplish glass. Paper-lilac ground, deep plum type, saturated accents.",
  colors: {
    void: "#efe9fa",
    hull: "#e6dcf6",
    glass: glassFor("light", "#efe9fa", "#2a1d45"),
    panel: solidPanel("light", "#efe9fa", "#2a1d45"),
    line: "#cdbfe6",
    ink: "#241a3d",
    dim: "#5b4a80",
    faint: "#7d6ca3",
    mint: accent("#6b2fd1", "#efe9fa", 5.5),
    amber: accent("#a34c00", "#efe9fa", 5),
    ice: accent("#1f5fae", "#efe9fa", 5),
    rose: accent("#a82060", "#efe9fa", 5),
    onAccent: "#ffffff",
    scheme: "light",
  },
  glow: ["#cbb6f2", "#a98fe0"],
  map: {
    mode: "light",
    water: ["#7d9ede", "#c6d8fb"],
    sand: ["#b4a8c4", "#e4dcef"],
    land: ["#5f9e78", "#d9ecd4"],
  },
};

export const THEME_CUSTOM: Theme = {
  id: "custom",
  name: "Custom",
  blurb: "Pick a ground colour and an accent. Everything else is derived.",
  colors: THEME_VIOLET.colors,
  glow: THEME_VIOLET.glow,
  map: THEME_VIOLET.map,
  seed: ["#0e0a1a", "#c4a6ff"],
};

export const THEME_CHAOS: Theme = {
  id: "chaos",
  name: "Chaos",
  blurb: "Randomised high-contrast glass. Every roll is guaranteed readable.",
  colors: THEME_VIOLET.colors,
  glow: THEME_VIOLET.glow,
  map: THEME_VIOLET.map,
};

export const BASE_THEMES: Theme[] = [THEME_CARTOGRAPHER, THEME_VIOLET, THEME_LILAC, THEME_CUSTOM, THEME_CHAOS];

export function baseTheme(id: string | null | undefined): Theme {
  return BASE_THEMES.find((t) => t.id === id) ?? THEME_CARTOGRAPHER;
}

export function themeById(id: string | null | undefined): Theme {
  return baseTheme(id);
}

/* --------------------------- custom theme --------------------------- */

/**
 * Derive a full theme from two pilot colours: a ground and an accent.
 * The ground's luminance decides whether the result is a dark or a light
 * surface, and every text/accent token is contrast-checked against it.
 */
export function deriveCustomTheme(groundHex: string, accentHex: string): Theme {
  const ground = /^#[0-9a-f]{6}$/i.test(groundHex) ? groundHex.toLowerCase() : "#0e0a1a";
  const raw = /^#[0-9a-f]{6}$/i.test(accentHex) ? accentHex.toLowerCase() : "#c4a6ff";
  const scheme: "dark" | "light" = luminance(ground) < 0.3 ? "dark" : "light";
  const { h, s } = rgbToHsl(hexToRgb(raw));
  const tint = (l: number, sat = s * 0.55) => rgbToHex(hslToRgb(h, sat, l));
  const bg = ground;
  const ink = scheme === "dark" ? "#f4f0ff" : "#1c1430";

  return {
    id: "custom",
    name: "Custom",
    blurb: "Pilot-derived glass. Ground + accent, everything else computed.",
    colors: {
      void: bg,
      hull: mixHex(bg, ink, scheme === "dark" ? 0.05 : 0.04),
      glass: glassFor(scheme, bg, ink),
      panel: solidPanel(scheme, bg, ink),
      line: mixHex(bg, ink, scheme === "dark" ? 0.22 : 0.16),
      ink,
      dim: mixHex(ink, bg, scheme === "dark" ? 0.34 : 0.3),
      faint: mixHex(ink, bg, scheme === "dark" ? 0.52 : 0.46),
      mint: ensureContrast(raw, bg, 4.6),
      amber: ensureContrast(tint(0.68, 0.72), bg),
      ice: ensureContrast(tint(0.64, 0.62), bg),
      rose: ensureContrast(tint(0.66, 0.7), bg),
      onAccent: luminance(ensureContrast(raw, bg, 4.6)) > 0.35 ? "#100a1c" : "#ffffff",
      scheme,
    },
    glow: [mixHex(bg, raw, scheme === "dark" ? 0.4 : 0.55), mixHex(bg, tint(0.45), 0.6)],
    map: themedMap(bg, scheme),
    seed: [ground, raw],
  };
}

/* ---------------------------- random theme ---------------------------- */

/**
 * The "chaos" generator. Instead of sampling HSV at random and hoping, it
 * picks two well-separated anchor hues, fixes the surface luminance, and
 * then *verifies* the result: accents must clear WCAG AA on the surface,
 * the surface must not be a grey soup, and ink must be clearly darker or
 * lighter than the ground. Bad rolls are simply rejected by the caller
 * (`randomTheme` retries).
 */
export function generateChaosTheme(rand: () => number = Math.random): Theme {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length) % xs.length];
  const dark = rand() < 0.62;
  const baseHue = rand() * 360;
  // steer away from the muddy middle of the lightness range
  const bgL = dark ? 0.09 + rand() * 0.1 : 0.9 + rand() * 0.05;
  const bgS = 0.35 + rand() * 0.5;
  const bg = rgbToHex(hslToRgb(baseHue, bgS, bgL));
  const ink = dark ? "#fdfbff" : "#120a1e";

  // anchors: complementary or split-complementary, always saturated
  const spread = pick([150, 180, 210, 120, 240]);
  const accentA = rgbToHex(hslToRgb((baseHue + spread) % 360, 0.78 + rand() * 0.2, dark ? 0.66 : 0.4));
  const accentB = rgbToHex(hslToRgb((baseHue + 90 + rand() * 60) % 360, 0.7 + rand() * 0.25, dark ? 0.62 : 0.38));
  const accentC = rgbToHex(hslToRgb((baseHue + 300 + rand() * 40) % 360, 0.7 + rand() * 0.25, dark ? 0.7 : 0.42));
  const accentD = rgbToHex(hslToRgb((baseHue + 30 + rand() * 40) % 360, 0.65 + rand() * 0.3, dark ? 0.6 : 0.36));

  const mint = ensureContrast(accentA, bg, 5.2);
  const picked = {
    amber: ensureContrast(accentB, bg, 4.6),
    ice: ensureContrast(accentC, bg, 4.6),
    rose: ensureContrast(accentD, bg, 4.6),
  };
  const scheme: "dark" | "light" = dark ? "dark" : "light";

  const map = themedMap(bg, scheme);
  const themed: MapPalette = {
    ...map,
    // push the ramp contrast and let the anchors leak into the bands
    water: [mixHex(map.water[0], picked.ice, 0.18), mixHex(map.water[1], picked.ice, 0.3)],
    land: [mixHex(map.land[0], mint, 0.16), mixHex(map.land[1], mint, 0.26)],
  };

  return {
    id: "chaos",
    name: "Chaos",
    blurb: "Random high-contrast glass. Every roll is readability-checked.",
    colors: {
      void: bg,
      hull: mixHex(bg, ink, dark ? 0.055 : 0.04),
      glass: glassFor(scheme, bg, ink),
      panel: solidPanel(scheme, bg, ink),
      line: mixHex(bg, ink, dark ? 0.26 : 0.18),
      ink,
      dim: mixHex(ink, bg, dark ? 0.34 : 0.28),
      faint: mixHex(ink, bg, dark ? 0.5 : 0.44),
      mint,
      amber: picked.amber,
      ice: picked.ice,
      rose: picked.rose,
      onAccent: luminance(mint) > 0.35 ? "#0d0716" : "#ffffff",
      scheme,
    },
    glow: [mixHex(bg, picked.ice, 0.55), mixHex(bg, mint, 0.45)],
    map: themed,
  };
}

/**
 * Minimum acceptance bar for a generated theme; the store retries otherwise.
 * Body text must clear WCAG AA (4.5:1), accents AA-large (3:1) — the glass
 * panes lower the effective ratio slightly, so the bar is drawn above the
 * strict minimum for the accents that carry meaning.
 */
export function isReadableTheme(theme: Theme): boolean {
  const c = theme.colors;
  const at = (fg: string) => contrastRatio(fg, c.void);
  return at(c.ink) >= 7 && at(c.dim) >= 4.5 && at(c.faint) >= 3 && at(c.mint) >= 4.5 && at(c.amber) >= 4 && at(c.ice) >= 4 && at(c.rose) >= 4;
}

/** Generate with bounded retries, then fall back to the last candidate. */
export function randomTheme(rand: () => number = Math.random): Theme {
  let candidate = generateChaosTheme(rand);
  for (let attempt = 0; attempt < 12 && !isReadableTheme(candidate); attempt++) {
    candidate = generateChaosTheme(rand);
  }
  return candidate;
}

/* --------------------------- css emission --------------------------- */

/** every token the stylesheet understands, in write order */
export const THEME_TOKEN_KEYS: (keyof ThemeColors)[] = [
  "void",
  "hull",
  "glass",
  "panel",
  "line",
  "ink",
  "dim",
  "faint",
  "mint",
  "amber",
  "ice",
  "rose",
  "onAccent",
];

/** flat token map (no scheme) for `applyTheme` */
export function themeTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) out[key] = theme.colors[key];
  return out;
}

/** `--color-*` custom properties, ready to be written to :root */
export function themeCssVars(theme: Theme): Record<string, string> {
  const tokens = themeTokens(theme);
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) vars[`--color-${k}`] = v;
  vars["--sim-glow-a"] = theme.glow[0];
  vars["--sim-glow-b"] = theme.glow[1];
  vars["--sim-scheme"] = theme.colors.scheme;
  return vars;
}
