/* ------------------------------------------------------------------ *
 * SIMPLAYZ TERRAIN ENGINE  (a.k.a. "HALLUCINATOR-9")
 * ------------------------------------------------------------------ *
 * OpenStreetMap tells us *where* a place is. It does not hand us a
 * playable relief model, so the engine synthesises one:
 *
 *   • domain-warped fractal Brownian motion  -> continental field
 *   • ridged multifractal                    -> orogeny / mountain belts
 *   • zero-crossing carving of a slow field  -> fluvial network
 *   • wetness vs relief interplay            -> lakes, marsh, reed beds
 *   • coupled cell automa (wet/temp/forest)  -> 14 biome classes
 *   • "town gravity" attractors              -> legacy sprawl masks
 *
 * Sampling is a pure function of (longitude, latitude, seed) evaluated in
 * EPSG:3857 projected metres, so the tile streamer, the survey grids stored
 * in Postgres, the three.js mesh and the tour-mode ground physics all agree
 * on the ground with zero synchronisation. Same seed -> same planet.
 * ------------------------------------------------------------------ */

import { lngLatToWorldM, mercatorScale, offsetLngLat } from "@/engine/geo";

export interface BiomeDef {
  id: number;
  key: string;
  name: string;
  color: string;
  /** 0..1 soil quality */
  fertility: number;
  /** multiplier applied to defensive value of structures standing on it */
  cover: number;
  /** walking speed multiplier for tour avatars */
  walk: number;
  /** build cost multiplier */
  costMod: number;
  /** is construction permitted at all */
  buildable: boolean;
}

export const BIOMES: readonly BiomeDef[] = [
  { id: 0, key: "abyss", name: "Deep Water", color: "#06243d", fertility: 0, cover: 0.2, walk: 0.2, costMod: 9, buildable: false },
  { id: 1, key: "shelf", name: "Shallow Water", color: "#0d4a68", fertility: 0.1, cover: 0.3, walk: 0.3, costMod: 7, buildable: false },
  { id: 2, key: "marsh", name: "Reed Marsh", color: "#2f5a49", fertility: 0.45, cover: 1.15, walk: 0.6, costMod: 1.7, buildable: true },
  { id: 3, key: "sand", name: "Sandflat", color: "#a89877", fertility: 0.15, cover: 0.7, walk: 0.85, costMod: 1, buildable: true },
  { id: 4, key: "plains", name: "Open Plains", color: "#7d9450", fertility: 0.8, cover: 0.85, walk: 1, costMod: 0.85, buildable: true },
  { id: 5, key: "meadow", name: "Lush Meadow", color: "#5f9550", fertility: 1, cover: 0.95, walk: 1, costMod: 0.9, buildable: true },
  { id: 6, key: "woodland", name: "Woodland", color: "#40684a", fertility: 0.7, cover: 1.25, walk: 0.8, costMod: 1.1, buildable: true },
  { id: 7, key: "oldgrowth", name: "Old Growth", color: "#274b37", fertility: 0.6, cover: 1.45, walk: 0.65, costMod: 1.25, buildable: true },
  { id: 8, key: "scrub", name: "Scrub Steppe", color: "#8d8a55", fertility: 0.5, cover: 1, walk: 0.95, costMod: 0.9, buildable: true },
  { id: 9, key: "rock", name: "Rockfield", color: "#6b6660", fertility: 0.15, cover: 1.35, walk: 0.6, costMod: 1.4, buildable: true },
  { id: 10, key: "scree", name: "Cliff & Scree", color: "#8a8378", fertility: 0.1, cover: 1.5, walk: 0.45, costMod: 1.65, buildable: true },
  { id: 11, key: "snow", name: "Snowfield", color: "#d7e2ec", fertility: 0.05, cover: 0.8, walk: 0.55, costMod: 1.8, buildable: true },
  { id: 12, key: "sprawl", name: "Legacy Sprawl", color: "#6d7076", fertility: 0.2, cover: 1.2, walk: 1, costMod: 1.15, buildable: true },
  { id: 13, key: "garden", name: "Garden Belt", color: "#59915e", fertility: 0.95, cover: 1.05, walk: 1, costMod: 0.95, buildable: true },
] as const;

export const BIOME_BY_KEY = new Map(BIOMES.map((b) => [b.key, b]));

/* ---------------------------- noise ---------------------------- */

function h2(ix: number, iy: number, seed: number) {
  let n = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967295;
}

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function sstep(edge0: number, edge1: number, x: number) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** value noise in 0..1 */
export function vnoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const a = h2(xi, yi, seed);
  const b = h2(xi + 1, yi, seed);
  const c = h2(xi, yi + 1, seed);
  const d = h2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export function fbm(x: number, y: number, seed: number, octaves = 5, lacunarity = 2.02, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * freq, y * freq, seed + i * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function ridged(x: number, y: number, seed: number, octaves = 5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoise(x * freq, y * freq, seed + i * 131) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.52;
    freq *= 2.07;
  }
  return sum / norm;
}

/* --------------------------- the field --------------------------- */

/** Relief in metres above the water datum, in projected-mercator metres. */
export function heightAtM(X: number, Y: number, seed: number) {
  const w1 = (fbm(X * 0.00016, Y * 0.00016, seed + 11, 3) - 0.5) * 1500;
  const w2 = (fbm(X * 0.00016, Y * 0.00016, seed + 29, 3) - 0.5) * 1500;
  const qx = X + w1;
  const qy = Y + w2;

  const base = fbm(qx * 0.00028, qy * 0.00028, seed, 5);
  const t = (base - 0.5) * 2;
  // +20 datum bias with a compressed downside: the planet is mostly dry land,
  // water arrives through the fluvial and lacustrine carve rather than the base field.
  let h = 20 + (t < 0 ? t * 20 : t * 118 * (1 + 0.8 * Math.pow(t, 2.1)));

  const mountains = ridged(qx * 0.00033, qy * 0.00033, seed + 7, 5);
  h += Math.pow(Math.max(0, mountains - 0.6) / 0.4, 1.4) * 330;

  // fluvial carving along the zero crossings of a slow field
  const rline = Math.abs(fbm(X * 0.00021 + 13.7, Y * 0.00021 - 4.3, seed + 57, 4) * 2 - 1);
  const river = 1 - sstep(0, 0.05, rline);
  if (h > -6) h -= river * (20 + 26 * sstep(0, 130, h)) * (1 - sstep(150, 400, h));

  // standing water where the wetness field beats the relief
  const wetRaw = fbm(X * 0.0009, Y * 0.0009, seed + 808, 4);
  if (h < 22 && h > -10) {
    const lake = sstep(0.82, 0.95, wetRaw) * (1 - river * 0.2);
    h -= lake * (9 + 12 * lake);
  }

  h += (fbm(X * 0.0058, Y * 0.0058, seed + 3, 3) - 0.5) * 4.2;
  return Math.max(-46, Math.min(920, h));
}

export function riverMaskM(X: number, Y: number, seed: number) {
  const rline = Math.abs(fbm(X * 0.00021 + 13.7, Y * 0.00021 - 4.3, seed + 57, 4) * 2 - 1);
  return 1 - sstep(0, 0.07, rline);
}

export interface TerrainSample {
  /** metres above the water datum */
  h: number;
  slopeDeg: number;
  wet: number;
  temp: number;
  forest: number;
  urban: number;
  river: number;
  biome: number;
}

/** Multi-signal sample directly in projected-mercator metres. */
export function sampleAt(X: number, Y: number, seed: number, lat: number): TerrainSample {
  const ground = Math.max(0.05, mercatorScale(lat));
  const h = heightAtM(X, Y, seed);
  const e = 9;
  const dx = (heightAtM(X + e, Y, seed) - heightAtM(X - e, Y, seed)) / (2 * e * ground);
  const dy = (heightAtM(X, Y + e, seed) - heightAtM(X, Y - e, seed)) / (2 * e * ground);
  const slopeDeg = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  const river = riverMaskM(X, Y, seed);
  const wet = Math.max(0, Math.min(1, fbm(X * 0.0009, Y * 0.0009, seed + 808, 4) * 0.72 + river * 0.45 + sstep(16, -3, h) * 0.4));
  const latFactor = 1 - Math.min(1, Math.abs(lat) / 66);
  const temp = Math.max(0, Math.min(1, latFactor * 0.62 + 0.38 * (1 - sstep(180, 720, h)) - sstep(0.75, 1, wet) * 0.12));
  const forestNoise = fbm(X * 0.0016, Y * 0.0016, seed + 909, 4);
  const forest = Math.max(
    0,
    Math.min(1, sstep(0.44, 0.7, forestNoise) * sstep(0, 7, h) * sstep(430, 250, h) * (0.55 + 0.75 * wet) * (1 - sstep(32, 46, slopeDeg) * 0.7)),
  );
  const cityPull = fbm(X * 0.0012, Y * 0.0012, seed + 404, 4);
  const flat = 1 - sstep(6, 22, slopeDeg);
  const urban = Math.max(0, Math.min(1, sstep(0.6, 0.79, cityPull) * (0.25 + 0.75 * flat) * sstep(-3, 9, h)));
  return { h, slopeDeg, wet, temp, forest, urban, river, biome: classify(h, wet, temp, slopeDeg, urban, forest) };
}

/** Full multi-signal sample from a coordinate. */
export function sampleTerrain(lng: number, lat: number, seed: number): TerrainSample {
  const { x, y } = lngLatToWorldM(lng, lat);
  return sampleAt(x, y, seed, lat);
}

export function heightAtLngLat(lng: number, lat: number, seed: number) {
  const { x, y } = lngLatToWorldM(lng, lat);
  return heightAtM(x, y, seed);
}

export function classify(h: number, wet: number, temp: number, slope: number, urban: number, forest: number) {
  if (h < -7) return 0;
  if (h < 1.5) return 1;
  if (h < 8 && wet > 0.66) return 2;
  if (temp < 0.2 && h > 150) return 11;
  if (h > 380 || (slope > 34 && h > 160)) return 10;
  if (h > 230 && slope > 16) return 9;
  if (slope > 22) return 9;
  if (urban > 0.45) return 12;
  if (wet > 0.62 && h < 12) return 2;
  if (forest > 0.62) return 7;
  if (forest > 0.32) return 6;
  if (wet > 0.44 && temp > 0.35) return 5;
  if (temp > 0.5 && wet < 0.3) return 8;
  if (h < 20 && wet > 0.3) return 13;
  if (wet < 0.22 && h < 60) return 3;
  return 4;
}

/* ------------------------ parcel survey ------------------------ */

export interface SurveyCell {
  /** metres above datum, quantised */
  y: number;
  /** biome index */
  b: number;
  /** 0 = no build, 1 = clear, 2 = costly */
  ok: number;
}

export interface SurveyProfile {
  avgElevation: number;
  avgSlope: number;
  maxElevation: number;
  waterFraction: number;
  forestFraction: number;
  urbanFraction: number;
  farmScore: number;
  buildScore: number;
  defenseScore: number;
  biomass: number;
  minerals: number;
  hydro: number;
  histogram: { key: string; name: string; color: string; share: number }[];
}

export interface SurveyResult {
  cells: number;
  cellSizeM: number;
  grid: SurveyCell[];
  profile: SurveyProfile;
}

/**
 * Survey a square parcel of `sizeM` metres centred on a coordinate into a
 * cells×cells gameplay grid. Client and server call this with identical
 * arguments, so the persisted grid is always reproducible from the claim.
 */
export function surveyParcel(
  centerLng: number,
  centerLat: number,
  sizeM: number,
  cells: number,
  seed: number,
  zoom: number,
): SurveyResult {
  const half = sizeM / 2;
  const cellSize = sizeM / cells;
  const grid: SurveyCell[] = new Array(cells * cells);
  let sumH = 0;
  let sumSlope = 0;
  let maxH = -1e9;
  let water = 0;
  let forest = 0;
  let urban = 0;
  let farm = 0;
  let build = 0;
  let defense = 0;
  let biomass = 0;
  let minerals = 0;
  let hydro = 0;
  const counts = new Array<number>(BIOMES.length).fill(0);

  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const mx = -half + (cx + 0.5) * cellSize;
      const my = -half + (cy + 0.5) * cellSize;
      const p = offsetLngLat(centerLng, centerLat, mx, my, zoom);
      const s = sampleTerrain(p.lng, p.lat, seed);
      const b = BIOMES[s.biome];
      counts[s.biome] += 1;
      sumH += s.h;
      sumSlope += s.slopeDeg;
      if (s.h > maxH) maxH = s.h;
      const deep = !b.buildable || s.h < 1.5;
      if (deep) water++;
      if (s.biome === 6 || s.biome === 7) forest++;
      if (s.biome === 12) urban++;
      farm += b.fertility * (s.h > 2 && s.slopeDeg < 9 ? 1 : 0.25);
      build += (b.buildable && s.slopeDeg < 14 ? 1 : 0.15) / Math.max(0.6, b.costMod);
      defense += 0.5 + s.slopeDeg / 30 + b.cover * 0.35;
      biomass += b.fertility * (0.4 + s.forest);
      minerals += sstep(30, 300, s.h) * 0.7 + sstep(18, 2, s.wet) * 0.3 + (s.biome === 9 || s.biome === 10 ? 0.6 : 0);
      hydro += (s.river > 0.4 ? 0.8 : 0) + sstep(10, 0, s.h) * 0.5 + s.wet * 0.35;

      const ok = deep ? 0 : s.slopeDeg > 20 ? 2 : 1;
      grid[cy * cells + cx] = { y: Math.round(s.h * 20) / 20, b: s.biome, ok };
    }
  }

  const n = cells * cells;
  const histogram = BIOMES.map((b, i) => ({
    key: b.key,
    name: b.name,
    color: b.color,
    share: Math.round((counts[i] / n) * 1000) / 10,
  }))
    .filter((row) => row.share > 0)
    .sort((a, b) => b.share - a.share);

  return {
    cells,
    cellSizeM: Math.round(cellSize * 100) / 100,
    grid,
    profile: {
      avgElevation: Math.round(sumH / n),
      avgSlope: Math.round((sumSlope / n) * 10) / 10,
      maxElevation: Math.round(maxH),
      waterFraction: Math.round((water / n) * 1000) / 1000,
      forestFraction: Math.round((forest / n) * 1000) / 1000,
      urbanFraction: Math.round((urban / n) * 1000) / 1000,
      farmScore: Math.round((farm / n) * 100) / 100,
      buildScore: Math.round((build / n) * 100) / 100,
      defenseScore: Math.round((defense / n) * 100) / 100,
      biomass: Math.round((biomass / n) * 100) / 100,
      minerals: Math.round((minerals / n) * 100) / 100,
      hydro: Math.round((hydro / n) * 100) / 100,
      histogram,
    },
  };
}

/**
 * Cheap render path: relief + biome class with a two-tap slope proxy.
 * Used per mesh vertex by the three.js sector builder.
 */
export function quickSample(lng: number, lat: number, seed: number) {
  const { x: X, y: Y } = lngLatToWorldM(lng, lat);
  const ground = Math.max(0.05, mercatorScale(lat));
  const h = heightAtM(X, Y, seed);
  const e = 14;
  const slopeDeg = (Math.atan(Math.abs(heightAtM(X + e, Y, seed) - heightAtM(X - e, Y, seed)) / (2 * e * ground)) * 180) / Math.PI;
  const river = riverMaskM(X, Y, seed);
  const wet = Math.max(0, Math.min(1, fbm(X * 0.0009, Y * 0.0009, seed + 808, 3) * 0.72 + river * 0.45 + sstep(16, -3, h) * 0.4));
  const latFactor = 1 - Math.min(1, Math.abs(lat) / 66);
  const temp = Math.max(0, Math.min(1, latFactor * 0.62 + 0.38 * (1 - sstep(180, 720, h)) - sstep(0.75, 1, wet) * 0.12));
  const forestNoise = fbm(X * 0.0016, Y * 0.0016, seed + 909, 3);
  const forest = Math.max(0, Math.min(1, sstep(0.44, 0.7, forestNoise) * sstep(0, 7, h) * sstep(430, 250, h) * (0.55 + 0.75 * wet)));
  const cityPull = fbm(X * 0.0012, Y * 0.0012, seed + 404, 3);
  const urban = Math.max(0, Math.min(1, sstep(0.6, 0.79, cityPull) * (0.3 + 0.7 * (1 - sstep(6, 22, slopeDeg))) * sstep(-3, 9, h)));
  return { h, biome: classify(h, wet, temp, slopeDeg, urban, forest), wet, urban, river };
}

/** deterministic unit generator from integer-ish inputs (no Math.random in logic) */
export function hashSeed(...nums: number[]) {
  let n = 2166136261;
  for (const v of nums) {
    n ^= Math.round(v * 1000) | 0;
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0) / 4294967295;
}
