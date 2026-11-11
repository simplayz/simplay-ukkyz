/* ------------------------------------------------------------------ *
 * Simplayz geodesy — slippy-map maths shared by the tile streamer,
 * the terrain engine and the three.js sector frame.
 * ------------------------------------------------------------------ */

export const TILE_PX = 256;
export const ORIGIN_SHIFT = 20037508.342789244;

export function clampLat(lat: number) {
  return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

/** longitude / latitude -> normalised mercator (0..1) */
export function lngLatToMerc(lng: number, lat: number) {
  const x = (lng + 180) / 360;
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

export function mercToLngLat(mx: number, my: number) {
  const lng = mx * 360 - 180;
  const n = Math.PI * (1 - 2 * my);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lng, lat };
}

export function tileSizePx(z: number) {
  return TILE_PX * Math.pow(2, z);
}

export function lngLatToTileF(lng: number, lat: number, z: number) {
  const m = lngLatToMerc(lng, lat);
  const n = tileSizePx(z);
  return { fx: m.x * n / TILE_PX, fy: m.y * n / TILE_PX };
}

export function tileFToLngLat(fx: number, fy: number, z: number) {
  const n = tileSizePx(z);
  return mercToLngLat((fx * TILE_PX) / n, (fy * TILE_PX) / n);
}

export function tileForLngLat(lng: number, lat: number, z: number) {
  const f = lngLatToTileF(lng, lat, z);
  const max = Math.pow(2, z) - 1;
  return {
    z,
    x: Math.max(0, Math.min(max, Math.floor(f.fx))),
    y: Math.max(0, Math.min(max, Math.floor(f.fy))),
  };
}

/** metres per pixel of a tile at a given latitude (Web Mercator scale) */
export function metersPerPixel(lat: number, z: number) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
}

export function tileBoundsLngLat(x: number, y: number, z: number) {
  const nw = tileFToLngLat(x, y, z);
  const se = tileFToLngLat(x + 1, y + 1, z);
  return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
}

/**
 * Local planar frame anchored on a tile corner. Inside a single sector
 * (a few tiles wide) treating metres-per-pixel as constant is accurate
 * to well under one percent, which keeps the three.js maths trivial.
 */
export class SectorFrame {
  readonly z: number;
  readonly mPerPx: number;
  readonly tilePx: number;
  readonly sizeM: number;
  readonly originX: number;
  readonly originY: number;
  readonly originTileX: number;
  readonly originTileY: number;
  readonly centerLng: number;
  readonly centerLat: number;

  constructor(centerLng: number, centerLat: number, z: number, tilesWide = 3) {
    this.z = z;
    const center = lngLatToTileF(centerLng, centerLat, z);
    const span = tilesWide;
    this.originTileX = Math.round(center.fx - span / 2);
    this.originTileY = Math.round(center.fy - span / 2);
    this.mPerPx = metersPerPixel(centerLat, z);
    this.tilePx = TILE_PX;
    this.sizeM = this.tilePx * this.mPerPx;
    this.originX = this.originTileX * this.tilePx;
    this.originY = this.originTileY * this.tilePx;
    const c = tileFToLngLat(this.originX / this.tilePx + span / 2, this.originY / this.tilePx + span / 2, z);
    this.centerLng = c.lng;
    this.centerLat = c.lat;
  }

  /** local metres (east+, south+) -> lng/lat */
  localToLngLat(x: number, y: number) {
    return tileFToLngLat((this.originX + x / this.mPerPx) / this.tilePx, (this.originY + y / this.mPerPx) / this.tilePx, this.z);
  }

  lngLatToLocal(lng: number, lat: number) {
    const f = lngLatToTileF(lng, lat, this.z);
    return {
      x: (f.fx * this.tilePx - this.originX) * this.mPerPx,
      y: (f.fy * this.tilePx - this.originY) * this.mPerPx,
    };
  }

  tileLocal(tileX: number, tileY: number) {
    return {
      x: (tileX - this.originTileX) * this.sizeM,
      y: (tileY - this.originTileY) * this.sizeM,
    };
  }
}

/**
 * Offset a coordinate by ground metres (east positive, south positive).
 * Uses constant metres-per-pixel at the origin latitude, which is the same
 * approximation the render sector uses, so client and server agree exactly.
 */
export function offsetLngLat(lng: number, lat: number, eastM: number, southM: number, z: number) {
  const mpp = metersPerPixel(lat, z) || 1;
  const f = lngLatToTileF(lng, lat, z);
  return tileFToLngLat(f.fx + eastM / (TILE_PX * mpp), f.fy + southM / (TILE_PX * mpp), z);
}

/** mercator scale factor: ground metres per projected metre */
export function mercatorScale(lat: number) {
  return Math.max(0.05, Math.cos((lat * Math.PI) / 180));
}

/** Web-Mercator (EPSG:3857) metres — the terrain engine's native frame */
export function lngLatToWorldM(lng: number, lat: number) {
  const x = (lng / 180) * ORIGIN_SHIFT;
  const rad = (clampLat(lat) * Math.PI) / 180;
  const y = (Math.log(Math.tan(Math.PI / 4 + rad / 2)) * ORIGIN_SHIFT) / Math.PI;
  return { x, y };
}

export function formatCoord(v: number, axis: "lng" | "lat") {
  const hemi = axis === "lng" ? (v >= 0 ? "E" : "W") : v >= 0 ? "N" : "S";
  return `${Math.abs(v).toFixed(5)}° ${hemi}`;
}
