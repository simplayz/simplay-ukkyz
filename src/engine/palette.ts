/* ------------------------------------------------------------------ *
 * SIMPLAYZ FLAT MAP PALETTE — "cartographer" 1.0
 * ------------------------------------------------------------------ *
 * The sector is rendered as a flat, unlit cartographic map: no relief
 * shading, no raster, no atmosphere. Landform is communicated purely by
 * hue instead of by height:
 *
 *   sea / lake / river  -> blue  gradient (deep -> shallow)
 *   beach / sand / marsh-> grey  gradient (wet sand -> dry sand)
 *   everything else     -> green gradient (lowland -> mountain)
 *
 * Two kinds of palettes live here:
 *
 *   • cartographic ramps (below) — fixed, hue-accurate, used by the
 *     "cartographer" theme and by the landing-page legend. Colour IS the
 *     data, so these must never be re-tinted by a UI theme.
 *   • thematic overrides (`themes.ts`, `MapPalette`) — dark/light purple,
 *     custom and high-contrast looks that recolour the same three bands.
 *
 * Pure module: no DOM, no React, no three.js — usable on both tiers.
 * ------------------------------------------------------------------ */

/** hue family a cell is painted with on the flat map */
export type LandClass = "water" | "sand" | "land";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface LandFractions {
  water: number;
  sand: number;
  land: number;
}

/** everything the flat palette needs to paint one sample */
export interface PaintInput {
  /** metres above the water datum */
  h: number;
  /** 0..1 wetness */
  wet: number;
  /** 0..1 forest canopy */
  forest: number;
  /** 0..1 legacy urban sprawl */
  urban: number;
  /** 0..1 river channel mask */
  river: number;
  /** BIOMES index */
  biome: number;
  /** classification coming back from the shared classifier (BIOMES index) */
  classified: number;
}

/** biome indices that read as open water (BIOMES: abyss, shelf) */
const BIOME_ABYSS = 0;
const BIOME_SHELF = 1;

/** the three cartographic ramps: low stop -> high stop, sRGB hex */
export const CARTO = {
  waterLow: "#052a4e",
  waterHigh: "#4bb8f0",
  sandLow: "#57524a",
  sandHigh: "#d3cdbf",
  landLow: "#1b7a43",
  landHigh: "#e9f6d8",
} as const;

/* ------------------------------ colour ------------------------------ */

export function hexToRgb(hex: string): Rgb {
  const v = hex.replace("#", "");
  const n = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  return {
    r: parseInt(n.slice(0, 2), 16) || 0,
    g: parseInt(n.slice(2, 4), 16) || 0,
    b: parseInt(n.slice(4, 6), 16) || 0,
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = Math.max(0, Math.min(1, s));
  const ll = Math.max(0, Math.min(1, l));
  if (ss === 0) {
    const v = ll * 255;
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: hue(hh + 1 / 3) * 255, g: hue(hh) * 255, b: hue(hh - 1 / 3) * 255 };
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t));
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

export function mixHex(a: string, b: string, t: number): string {
  return rgbToHex(mixRgb(hexToRgb(a), hexToRgb(b), t));
}

/** t in 0..1 -> ramp colour (two stops in sRGB) */
export function rampColor(low: string, high: string, t: number): Rgb {
  return mixRgb(hexToRgb(low), hexToRgb(high), t);
}

/**
 * WCAG relative luminance (0 = black, 1 = white). Themes use this to pick
 * readable chrome text at runtime instead of hard-coding "dark" or "light".
 */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Nudge a colour until it clears `target` against `bg`. Keeps hue and
 * saturation, walks lightness. Used by the random theme so generated
 * accents stay legible instead of relying on luck.
 */
export function ensureContrast(hex: string, bg: string, target = 4.5): string {
  if (contrastRatio(hex, bg) >= target) return hex;
  const { h, s, l } = rgbToHsl(hexToRgb(hex));
  const up = luminance(bg) < 0.35;
  for (let step = 1; step <= 20; step++) {
    const next = Math.max(0, Math.min(1, l + (up ? 1 : -1) * step * 0.045));
    const candidate = rgbToHex(hslToRgb(h, s, next));
    if (contrastRatio(candidate, bg) >= target) return candidate;
    if (next === 0 || next === 1) break;
  }
  return up ? "#f2f4ff" : "#0a0a12";
}

/* ------------------------- land classification ------------------------- */

/**
 * Assign a cell to one of the three cartographic bands.
 *
 * Height decides (the map is flat, so elevation is the only signal), but
 * the biome classifier gets the final word when it disagrees: a "shelf"
 * cell is water even at the edge of the datum, and marsh is painted as
 * wet sand rather than as a lake because it is buildable ground.
 */
export function classifyLand(input: PaintInput): LandClass {
  const { h, wet, classified, biome } = input;
  if (h < 1.5) return "water";
  if (classified === BIOME_ABYSS || classified === BIOME_SHELF || biome === BIOME_ABYSS || biome === BIOME_SHELF) return "water";
  if (h < 8 && wet > 0.66) return "water";
  if (h < 7.5) return "sand";
  if (classified >= 2 && classified <= 3) return "sand";
  if (h < 14 && wet > 0.62) return "sand";
  return "land";
}

/* ------------------------------ ramps ------------------------------ */

/** water depth 0..1 -> deep -> shallow */
export function waterFactor(input: PaintInput): number {
  const byDepth = Math.max(0, Math.min(1, (input.h + 22) / 26));
  const byWet = 0.55 + 0.3 * input.wet + 0.15 * Math.min(1, input.river * 2);
  return Math.max(0, Math.min(1, byDepth * 0.7 + byWet * 0.3));
}

/** beach wetness 0..1 -> wet grey -> dry light grey */
export function sandFactor(input: PaintInput): number {
  const dry = Math.max(0, Math.min(1, (input.h - 1.5) / 8));
  return Math.max(0, Math.min(1, dry * 0.75 + (1 - input.wet) * 0.25));
}

/**
 * Land elevation 0..1 -> lowland green -> mountain pale green.
 *
 * Real surveys cluster low: most cells sit between 30 m and 250 m, so a
 * linear map to 0..1 would leave the whole map at the pale end. The ramp
 * is therefore compressed around the inhabited band (7 m .. 300 m) and
 * given a gamma so flat ground stays deep green while true summits are
 * the only thing that reaches the pale stop.
 */
export function landFactor(input: PaintInput): number {
  const elev = Math.max(0, Math.min(1, (input.h - 7) / 300));
  const relief = Math.pow(elev, 1.25);
  const canopy = 1 - Math.min(1, input.forest * 0.55);
  const built = 1 - Math.min(1, input.urban * 0.3);
  const shade = (canopy * built - 1) * 0.12;
  return Math.max(0, Math.min(1, relief * 0.94 + 0.06 + shade));
}

/** fraction of water / sand / land in a sampled grid */
export function landFractions(classes: LandClass[]): LandFractions {
  const n = Math.max(1, classes.length);
  let water = 0;
  let sand = 0;
  for (const c of classes) {
    if (c === "water") water++;
    else if (c === "sand") sand++;
  }
  return {
    water: Math.round((water / n) * 1000) / 1000,
    sand: Math.round((sand / n) * 1000) / 1000,
    land: Math.round((1 - (water + sand) / n) * 1000) / 1000,
  };
}

/* ------------------------------ theme palettes ------------------------------ */

export type PaletteMode = "cartographer" | "dark" | "light" | "custom" | "random";

/** per-band gradient stops; every theme expresses the map as three ramps */
export interface MapPalette {
  mode: PaletteMode;
  /** low (deep water) -> high (shallow water) */
  water: readonly [string, string];
  /** low (wet sand) -> high (dry sand) */
  sand: readonly [string, string];
  /** low (lowland) -> high (mountain) */
  land: readonly [string, string];
}

/** the fixed, hue-accurate map (theme "cartographer") */
export const CARTO_PALETTE: MapPalette = {
  mode: "cartographer",
  water: [CARTO.waterLow, CARTO.waterHigh],
  sand: [CARTO.sandLow, CARTO.sandHigh],
  land: [CARTO.landLow, CARTO.landHigh],
};

/** paint one sample on a flat map. Returns sRGB bytes, ready for vertex colours. */
export function paintFlatColor(palette: MapPalette, input: PaintInput): Rgb {
  const kind = classifyLand(input);
  if (kind === "water") return rampColor(palette.water[0], palette.water[1], waterFactor(input));
  if (kind === "sand") return rampColor(palette.sand[0], palette.sand[1], sandFactor(input));
  return rampColor(palette.land[0], palette.land[1], landFactor(input));
}

/** handy for legends / minimaps: the colour at the middle of each ramp */
export function swatches(palette: MapPalette): { water: string; sand: string; land: string } {
  return {
    water: rgbToHex(rampColor(palette.water[0], palette.water[1], 0.6)),
    sand: rgbToHex(rampColor(palette.sand[0], palette.sand[1], 0.55)),
    land: rgbToHex(rampColor(palette.land[0], palette.land[1], 0.45)),
  };
}
