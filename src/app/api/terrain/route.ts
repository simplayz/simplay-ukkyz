import { loadConfig, pilotFrom, snapshot, surveyAt, worldStats } from "@/lib/server";
import { surveyParcel } from "@/engine/terrain";
import { tileForLngLat } from "@/engine/geo";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { claims as claimsTable } from "@/db/schema";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ *
 * Terrain engine endpoint — authoritative survey grids.
 *   GET  /api/terrain?lng=..&lat=..        survey the parcel at a point
 *   GET  /api/terrain?claim=<id>           replay a stored claim survey
 *   GET  /api/terrain?debug=1              engine telemetry
 * ------------------------------------------------------------------ */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const config = await loadConfig();
  const claimId = url.searchParams.get("claim");
  const lng = Number(url.searchParams.get("lng"));
  const lat = Number(url.searchParams.get("lat"));
  const t0 = Date.now();

  if (url.searchParams.get("debug") === "1") {
    return Response.json({
      ok: true,
      config,
      stats: await worldStats(),
      snapshot: await snapshot(pilotFrom(req)),
      ms: Date.now() - t0,
    });
  }

  if (claimId) {
    const rows = await db.select().from(claimsTable).where(eq(claimsTable.id, claimId)).limit(1);
    if (!rows.length) return Response.json({ ok: false, error: "claim not found" }, { status: 404 });
    const c = rows[0];
    const survey = surveyParcel(c.centerLng, c.centerLat, c.sizeM, config.gridCells, config.terrainSeed, c.tileZ);
    return Response.json({ ok: true, claimId: c.id, tile: { z: c.tileZ, x: c.tileX, y: c.tileY }, survey, ms: Date.now() - t0 });
  }

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return Response.json({ ok: false, error: "lng/lat required" }, { status: 400 });
  }

  const { survey, cached, age } = await surveyAt(lng, lat, config);
  return Response.json({
    ok: true,
    tile: tileForLngLat(lng, lat, config.tileZoom),
    seed: config.terrainSeed,
    cached,
    ageSeconds: age,
    ms: Date.now() - t0,
    survey,
  });
}
