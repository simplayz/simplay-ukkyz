import { sql } from "drizzle-orm";
import { db } from "@/db";
import { tileCache, claims as claimsTable, buildings as buildingsTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { loadConfig } from "@/lib/server";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ *
 * INTERNAL TILE STREAMER
 * ------------------------------------------------------------------ *
 * Today the raster comes from OpenStreetMap; tomorrow it comes from what
 * gamers built. Every tile therefore flows through this route so the engine
 * owns caching, provenance, hit accounting and the "authored overlay" flag.
 * Player-authored parcels on a tile are detected live and reported in
 * X-Simplayz-Overlay so downstream consumers know a tile is no longer raw.
 * ------------------------------------------------------------------ */

const MAX_CACHED_TILES = 4000;

function pngPlaceholder(label: string) {
  // 1x1 transparent-ish slate pixel, hand-assembled PNG (no deps).
  const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: Uint8Array[] = [header];
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length);
    const body = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(data, 4);
    const crcBytes = new Uint8Array(4);
    new DataView(crcBytes.buffer).setUint32(0, crc(body));
    const out = new Uint8Array(len.length + body.length + crcBytes.length);
    out.set(len, 0);
    out.set(body, 4);
    out.set(crcBytes, 4 + body.length);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type grey
  const grey = new Uint8Array([0x78]);
  chunks.push(chunk("IHDR", ihdr), chunk("GDAY", grey), chunk("IEND", new Uint8Array(0)));
  void label;
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function GET(req: Request, ctx: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z: zs, x: xs, y: ys } = await ctx.params;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  // integers only: a fractional z would build "15.5/…" keys that never hit the cache
  if (![z, x, y].every((v) => Number.isInteger(v)) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return Response.json({ ok: false, error: "tile out of range" }, { status: 400 });
  }
  const config = await loadConfig();
  const key = `${z}/${x}/${y}`;
  const url = new URL(req.url);
  const purge = url.searchParams.get("purge") === "1";
  if (purge) {
    // a purge must evict the row, otherwise the next request serves it again
    try {
      await db.delete(tileCache).where(eq(tileCache.key, key));
    } catch {
      /* cache eviction is best effort */
    }
  }

  let cached: { png: Buffer; expiresAt: Date; hits: number } | null = null;
  try {
    const rows = await db
      .select({ png: tileCache.png, expiresAt: tileCache.expiresAt, hits: tileCache.hits })
      .from(tileCache)
      .where(eq(tileCache.key, key))
      .limit(1);
    cached = rows[0] ?? null;
  } catch {
    cached = null;
  }

  const fresh = cached && new Date(cached.expiresAt).getTime() > Date.now();
  if (fresh && !purge) {
    try {
      await db.update(tileCache).set({ hits: sql`${tileCache.hits} + 1` }).where(eq(tileCache.key, key));
    } catch {
      /* ignore */
    }
    return respond(cached!.png, "cache", key, config.tileTtlHours, cached!.hits + 1);
  }

  let upstream: Response | null = null;
  try {
    upstream = await fetch(`${config.tileSource}/${key}.png`, {
      headers: {
        "user-agent": "SimplayzEngine/1.0 (+https://simplayz.world/ops; tile-streamer) node-fetch",
        accept: "image/png,image/*",
      },
      cache: "no-store",
    });
  } catch {
    upstream = null;
  }

  if (upstream && upstream.ok) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    try {
      await db
        .insert(tileCache)
        .values({ key, z, x, y, png: buf, byteLen: buf.length, fetchedAt: new Date(), expiresAt: new Date(Date.now() + config.tileTtlHours * 3600_000) })
        .onConflictDoUpdate({ target: tileCache.key, set: { png: buf, byteLen: buf.length, fetchedAt: new Date(), expiresAt: new Date(Date.now() + config.tileTtlHours * 3600_000) } });
      const count = await db.select({ n: sql<number>`count(*)::int` }).from(tileCache);
      if ((count[0]?.n ?? 0) > MAX_CACHED_TILES) {
        await db.execute(sql`delete from tile_cache where key in (select key from tile_cache order by fetched_at asc limit 500)`);
      }
    } catch {
      /* cache write is best effort */
    }
    return respond(buf, "origin", key, config.tileTtlHours, 0);
  }

  if (cached) return respond(cached.png, "stale", key, 0, cached.hits);

  const bytes = pngPlaceholder(key);
  return respond(Buffer.from(bytes), "generated", key, 0, 0);
}

async function respond(buf: Uint8Array | Buffer, source: string, key: string, ttlHours: number, hits: number) {
  // `generated` is the 1x1 placeholder: never let a CDN cache it for 36 hours
  const cacheable = ttlHours > 0 && source !== "generated";
  const [z, x, y] = key.split("/").map(Number);
  let overlay = "raw";
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(claimsTable)
      .where(sql`${claimsTable.tileZ} = ${z} and ${claimsTable.tileX} = ${x} and ${claimsTable.tileY} = ${y}`);
    const b = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(buildingsTable)
      .innerJoin(claimsTable, sql`${buildingsTable.claimId} = ${claimsTable.id}`)
      .where(sql`${claimsTable.tileZ} = ${z} and ${claimsTable.tileX} = ${x} and ${claimsTable.tileY} = ${y}`);
    const authored = (rows[0]?.n ?? 0) > 0;
    overlay = authored ? `player-authored:${rows[0]?.n ?? 0}parcel/${b[0]?.n ?? 0}structures` : "raw";
  } catch {
    /* ignore */
  }
  return new Response(buf as unknown as BodyInit, {
    headers: {
      "content-type": "image/png",
      "cache-control": cacheable ? `public, max-age=${Math.round(ttlHours * 3600)}, stale-while-revalidate=86400` : "no-store",
      "x-simplayz-tile-source": source,
      "x-simplayz-tile-key": key,
      "x-simplayz-tile-hits": String(hits),
      "x-simplayz-overlay": overlay,
      "access-control-allow-origin": "*",
    },
  });
}
