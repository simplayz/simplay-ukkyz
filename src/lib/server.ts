import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { buildings as buildingsTable, claims as claimsTable, players as playersTable, terrainRegions, tileCache, worldConfig, worldEvents } from "@/db/schema";
import { surveyParcel, type SurveyResult } from "@/engine/terrain";
import { computeTotals } from "@/engine/simulation";
import { tileForLngLat } from "@/engine/geo";
import type { BuildingDTO, ClaimDTO, EventDTO, PlayerDTO, WorldConfigDTO, WorldSnapshot, LeaderRow } from "@/lib/types";

export const ENGINE_IDENTITY = {
  name: "SIMPLAYZ TERRAIN ENGINE",
  build: "hallucinator-9.4",
  model: "fBm + ridged orogeny + fluvial carving + biome automa",
};

export const DEFAULT_CONFIG: WorldConfigDTO = {
  claimSizeM: 1000,
  gridCells: 48,
  lockHours: 72,
  maxClaims: 3,
  tileZoom: 15,
  tileSource: "https://tile.openstreetmap.org",
  tileTtlHours: 36,
  terrainCacheSeconds: 600,
  terrainSeed: 20770418,
  reliefScale: 1.35,
  tickMinutes: 5,
  startCredits: 9000,
  assaultEnabled: true,
};

export function pilotFrom(req: Request): string | null {
  const h = req.headers.get("x-simplayz-pilot");
  if (h && /^[a-zA-Z0-9-]{6,64}$/.test(h)) return h;
  return null;
}

export async function loadConfig(): Promise<WorldConfigDTO> {
  try {
    const rows = await db.select().from(worldConfig).limit(1);
    if (rows.length === 0) {
      const inserted = await db
        .insert(worldConfig)
        .values({ id: 1, ...DEFAULT_CONFIG })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) return DEFAULT_CONFIG;
      return mapConfig(inserted[0]);
    }
    return mapConfig(rows[0]);
  } catch {
    return DEFAULT_CONFIG;
  }
}

type ConfigRow = typeof worldConfig.$inferSelect;

function mapConfig(r: ConfigRow): WorldConfigDTO {
  return {
    claimSizeM: r.claimSizeM ?? DEFAULT_CONFIG.claimSizeM,
    gridCells: r.gridCells ?? DEFAULT_CONFIG.gridCells,
    lockHours: r.lockHours ?? DEFAULT_CONFIG.lockHours,
    maxClaims: r.maxClaims ?? DEFAULT_CONFIG.maxClaims,
    tileZoom: r.tileZoom ?? DEFAULT_CONFIG.tileZoom,
    tileSource: r.tileSource ?? DEFAULT_CONFIG.tileSource,
    tileTtlHours: r.tileTtlHours ?? DEFAULT_CONFIG.tileTtlHours,
    terrainCacheSeconds: r.terrainCacheSeconds ?? DEFAULT_CONFIG.terrainCacheSeconds,
    terrainSeed: r.terrainSeed ?? DEFAULT_CONFIG.terrainSeed,
    reliefScale: r.reliefScale ?? DEFAULT_CONFIG.reliefScale,
    tickMinutes: r.tickMinutes ?? DEFAULT_CONFIG.tickMinutes,
    startCredits: r.startCredits ?? DEFAULT_CONFIG.startCredits,
    assaultEnabled: r.assaultEnabled ?? DEFAULT_CONFIG.assaultEnabled,
  };
}

export async function saveConfig(patch: Partial<WorldConfigDTO>): Promise<WorldConfigDTO> {
  await loadConfig();
  const clean: Record<string, unknown> = {};
  const keys = Object.keys(DEFAULT_CONFIG) as (keyof WorldConfigDTO)[];
  for (const k of keys) {
    const v = patch[k];
    if (v === undefined || v === null) continue;
    clean[k] = typeof v === "number" ? Math.round(v * 1000) / 1000 : v;
  }
  if (Object.keys(clean).length > 0) {
    clean.updatedAt = new Date();
    await db.update(worldConfig).set(clean).where(eq(worldConfig.id, 1));
  }
  return loadConfig();
}

function mapPlayer(r: typeof playersTable.$inferSelect): PlayerDTO {
  return {
    id: r.id,
    handle: r.handle,
    color: r.color,
    credits: r.credits,
    reputation: r.reputation,
    victories: r.victories,
    losses: r.losses,
    homeLng: r.homeLng,
    homeLat: r.homeLat,
  };
}

export async function ensurePilot(pilotId: string | null, init?: { handle?: string; homeLng?: number; homeLat?: number; color?: string }) {
  if (!pilotId) return null;
  try {
    const found = await db.select().from(playersTable).where(eq(playersTable.id, pilotId)).limit(1);
    if (found.length) {
      await db.update(playersTable).set({ lastSeenAt: new Date() }).where(eq(playersTable.id, pilotId));
      return mapPlayer(found[0]);
    }
    if (!init?.handle) return null;
    const handle = init.handle.trim().slice(0, 24) || "anonymous";
    const created = await db
      .insert(playersTable)
      .values({
        id: pilotId,
        handle,
        color: init.color ?? "#7df0c0",
        credits: (await loadConfig()).startCredits,
        homeLng: init.homeLng ?? 13.405,
        homeLat: init.homeLat ?? 52.52,
      })
      .onConflictDoNothing()
      .returning();
    if (created.length === 0) {
      const again = await db.select().from(playersTable).where(eq(playersTable.id, pilotId)).limit(1);
      return again.length ? mapPlayer(again[0]) : null;
    }
    return mapPlayer(created[0]);
  } catch {
    return null;
  }
}

export async function getPlayer(playerId: string | null): Promise<PlayerDTO | null> {
  if (!playerId) return null;
  try {
    const rows = await db.select().from(playersTable).where(eq(playersTable.id, playerId)).limit(1);
    return rows.length ? mapPlayer(rows[0]) : null;
  } catch {
    return null;
  }
}

export async function movePlayer(playerId: string, patch: { homeLng?: number; homeLat?: number; handle?: string; color?: string }) {
  const set: Record<string, unknown> = { lastSeenAt: new Date() };
  if (typeof patch.homeLng === "number") set.homeLng = patch.homeLng;
  if (typeof patch.homeLat === "number") set.homeLat = patch.homeLat;
  if (patch.handle) set.handle = patch.handle.slice(0, 24);
  if (patch.color) set.color = patch.color;
  await db.update(playersTable).set(set).where(eq(playersTable.id, playerId));
}

/* ----------------------------- surveys ----------------------------- */

export async function surveyForClaim(claim: typeof claimsTable.$inferSelect, config: WorldConfigDTO, refresh = false): Promise<SurveyResult> {
  const key = `claim:${claim.id}:${config.terrainSeed}:${claim.sizeM}:${config.gridCells}`;
  if (!refresh) {
    try {
      const hit = await db.select({ payload: terrainRegions.payload }).from(terrainRegions).where(eq(terrainRegions.key, key)).limit(1);
      if (hit.length) return hit[0].payload as unknown as SurveyResult;
    } catch {
      /* cache is best effort */
    }
  }
  const survey = surveyParcel(claim.centerLng, claim.centerLat, claim.sizeM, config.gridCells, config.terrainSeed, claim.tileZ);
  try {
    await db
      .insert(terrainRegions)
      .values({
        key,
        z: claim.tileZ,
        x: claim.tileX,
        y: claim.tileY,
        seed: config.terrainSeed,
        payload: survey as unknown as Record<string, unknown>,
        cellsEvaluated: survey.cells * survey.cells,
      })
      .onConflictDoUpdate({ target: terrainRegions.key, set: { payload: survey as unknown as Record<string, unknown>, createdAt: new Date() } });
  } catch {
    /* ignore cache write failure */
  }
  return survey;
}

/** Coordinate-only survey, used by the pre-claim survey preview. */
export async function surveyAt(lng: number, lat: number, config: WorldConfigDTO) {
  const tile = tileForLngLat(lng, lat, config.tileZoom);
  const key = `spot:${Math.round(lng * 20000)}:${Math.round(lat * 20000)}:${config.terrainSeed}:${config.claimSizeM}`;
  try {
    const hit = await db.select({ payload: terrainRegions.payload, createdAt: terrainRegions.createdAt }).from(terrainRegions).where(eq(terrainRegions.key, key)).limit(1);
    if (hit.length) {
      const age = (Date.now() - new Date(hit[0].createdAt).getTime()) / 1000;
      if (age < config.terrainCacheSeconds) return { survey: hit[0].payload as unknown as SurveyResult, cached: true, age: Math.round(age), tile };
    }
  } catch {
    /* ignore */
  }
  const survey = surveyParcel(lng, lat, config.claimSizeM, config.gridCells, config.terrainSeed, config.tileZoom);
  try {
    await db
      .insert(terrainRegions)
      .values({
        key,
        z: tile.z,
        x: tile.x,
        y: tile.y,
        seed: config.terrainSeed,
        payload: survey as unknown as Record<string, unknown>,
        cellsEvaluated: survey.cells * survey.cells,
      })
      .onConflictDoUpdate({ target: terrainRegions.key, set: { payload: survey as unknown as Record<string, unknown>, createdAt: new Date() } });
  } catch {
    /* ignore */
  }
  return { survey, cached: false, age: 0, tile };
}

/* ------------------------------ claims ------------------------------ */

export async function listClaims(filter: { ownerIds?: string[]; ids?: string[]; limit?: number }, config: WorldConfigDTO): Promise<ClaimDTO[]> {
  try {
    let rows = await db.select().from(claimsTable).orderBy(desc(claimsTable.createdAt)).limit(filter.limit ?? 96);
    if (filter.ownerIds) rows = rows.filter((r) => r.ownerId && filter.ownerIds!.includes(r.ownerId));
    if (filter.ids) rows = rows.filter((r) => filter.ids!.includes(r.id));
    if (rows.length === 0) return [];
    const bRows = await db
      .select()
      .from(buildingsTable)
      .where(inArray(buildingsTable.claimId, rows.map((r) => r.id)));
    const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId).filter(Boolean) as string[]));
    const owners = ownerIds.length ? await db.select().from(playersTable).where(inArray(playersTable.id, ownerIds)) : [];
    const byClaim = new Map<string, BuildingDTO[]>();
    for (const b of bRows) {
      const list = byClaim.get(b.claimId) ?? [];
      list.push({ id: b.id, kind: b.kind, cellX: b.cellX, cellY: b.cellY, rot: b.rot, level: b.level, integrity: b.integrity });
      byClaim.set(b.claimId, list);
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      owner: (() => {
        const o = owners.find((p) => p.id === r.ownerId);
        return o ? { handle: o.handle, color: o.color, reputation: o.reputation } : null;
      })(),
      centerLng: r.centerLng,
      centerLat: r.centerLat,
      tileZ: r.tileZ,
      tileX: r.tileX,
      tileY: r.tileY,
      sizeM: r.sizeM,
      status: r.status,
      lockedUntil: r.lockedUntil ? new Date(r.lockedUntil).toISOString() : null,
      defenseScore: r.defenseScore,
      prestige: r.prestige,
      income: r.income,
      population: r.population,
      profile: {
        avgElevation: r.avgElevation,
        avgSlope: r.avgSlope,
        maxElevation: Math.round(r.avgElevation * 2.4),
        waterFraction: r.waterFraction,
        forestFraction: r.forestFraction,
        urbanFraction: 0,
        farmScore: r.farmScore,
        buildScore: r.buildScore,
        defenseScore: r.defenseScore / 100,
        biomass: r.biomass,
        minerals: r.minerals,
        hydro: r.hydro,
        histogram: [],
      },
      buildings: byClaim.get(r.id) ?? [],
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function claimDto(row: typeof claimsTable.$inferSelect, config: WorldConfigDTO, survey?: SurveyResult): Promise<ClaimDTO> {
  const [dto] = await listClaims({ ids: [row.id] }, config);
  if (!dto) return row as unknown as ClaimDTO;
  if (survey) dto.profile = survey.profile;
  const totals = computeTotals(dto.buildings, survey ?? null, config.gridCells);
  dto.income = totals.netIncome;
  dto.population = totals.population;
  dto.defenseScore = totals.defense;
  dto.prestige = totals.prestige;
  return dto;
}

export async function syncClaimEconomy(claimId: string, config: WorldConfigDTO) {
  const rows = await db.select().from(claimsTable).where(eq(claimsTable.id, claimId)).limit(1);
  if (!rows.length) return null;
  const row = rows[0];
  const bRows = await db.select().from(buildingsTable).where(eq(buildingsTable.claimId, claimId));
  const survey = await surveyForClaim(row, config);
  const totals = computeTotals(
    bRows.map((b) => ({ id: b.id, kind: b.kind, cellX: b.cellX, cellY: b.cellY, rot: b.rot, level: b.level, integrity: b.integrity })),
    survey,
    config.gridCells,
  );
  await db
    .update(claimsTable)
    .set({
      defenseScore: totals.defense,
      prestige: totals.prestige,
      income: totals.netIncome,
      population: totals.population,
      updatedAt: new Date(),
    })
    .where(eq(claimsTable.id, claimId));
  return totals;
}

/** credit accrual driven by the configured tick cadence */
export async function applyTicks(playerId: string, config: WorldConfigDTO) {
  try {
    const rows = await db.select().from(claimsTable).where(eq(claimsTable.ownerId, playerId));
    if (rows.length === 0) return 0;
    const interval = Math.max(1, config.tickMinutes) * 60_000;
    let delta = 0;
    for (const row of rows) {
      const ticks = Math.floor((Date.now() - new Date(row.lastTickAt).getTime()) / interval);
      if (ticks <= 0) continue;
      const bRows = await db.select().from(buildingsTable).where(eq(buildingsTable.claimId, row.id));
      const survey = await surveyForClaim(row, config);
      const totals = computeTotals(
        bRows.map((b) => ({ id: b.id, kind: b.kind, cellX: b.cellX, cellY: b.cellY, rot: b.rot, level: b.level, integrity: b.integrity })),
        survey,
        config.gridCells,
      );
      delta += totals.netIncome * Math.min(ticks, 48);
      await db.update(claimsTable).set({ lastTickAt: new Date(), income: totals.netIncome, population: totals.population }).where(eq(claimsTable.id, row.id));
    }
    if (delta !== 0) {
      await db.update(playersTable).set({ credits: sql`greatest(0, ${playersTable.credits} + ${delta})` }).where(eq(playersTable.id, playerId));
    }
    return delta;
  } catch {
    return 0;
  }
}

export async function logEvent(entry: { claimId?: string | null; actorId?: string | null; type: string; message: string; meta?: Record<string, unknown> }) {
  try {
    await db.insert(worldEvents).values({
      claimId: entry.claimId ?? null,
      actorId: entry.actorId ?? null,
      type: entry.type,
      message: entry.message.slice(0, 400),
      meta: entry.meta ?? null,
    });
  } catch {
    /* logging must never break a mutation */
  }
}

export async function recentEvents(limit = 18): Promise<EventDTO[]> {
  try {
    const rows = await db.select().from(worldEvents).orderBy(desc(worldEvents.id)).limit(limit);
    return rows.map(toEventDTO);
  } catch {
    return [];
  }
}

function toEventDTO(r: typeof worldEvents.$inferSelect): EventDTO {
  return {
    id: r.id,
    type: r.type,
    message: r.message,
    claimId: r.claimId,
    actorId: r.actorId,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Events that concern one pilot: everything touching a parcel they own, plus
 * anything they did themselves.
 *
 * The unscoped `recentEvents()` tail is fine for the public world log, but it
 * is the wrong feed for a notification — in a busy world your own assault
 * notice gets pushed off the end of an 18-row list long before you see it.
 */
export async function eventsForPilot(pilotId: string, afterId = 0, limit = 40): Promise<EventDTO[]> {
  try {
    const owned = await db.select({ id: claimsTable.id }).from(claimsTable).where(eq(claimsTable.ownerId, pilotId));
    const ids = owned.map((r) => r.id);
    const base = afterId > 0 ? gt(worldEvents.id, afterId) : undefined;
    const rows = await db
      .select()
      .from(worldEvents)
      .where(
        ids.length
          ? and(base, or(inArray(worldEvents.claimId, ids), eq(worldEvents.actorId, pilotId)))
          : and(base, eq(worldEvents.actorId, pilotId)),
      )
      .orderBy(desc(worldEvents.id))
      .limit(limit);
    // newest-first for the API, but the stream wants chronological order
    return rows.map(toEventDTO).reverse();
  } catch {
    return [];
  }
}

/** Opaque cursor for the event stream: highest id, or 0 on a cold start. */
export async function latestEventId(): Promise<number> {
  try {
    const rows = await db.select({ id: worldEvents.id }).from(worldEvents).orderBy(desc(worldEvents.id)).limit(1);
    return rows[0]?.id ?? 0;
  } catch {
    return 0;
  }
}

export async function leaderboard(config: WorldConfigDTO): Promise<LeaderRow[]> {
  try {
    const players = await db.select().from(playersTable).orderBy(desc(playersTable.reputation), desc(playersTable.credits)).limit(12);
    const counts = await db.select({ ownerId: claimsTable.ownerId, n: sql<number>`count(*)::int` }).from(claimsTable).groupBy(claimsTable.ownerId);
    return players.map((p) => ({
      id: p.id,
      handle: p.handle,
      color: p.color,
      credits: p.credits,
      reputation: p.reputation,
      victories: p.victories,
      losses: p.losses,
      claims: counts.find((c) => c.ownerId === p.id)?.n ?? 0,
      max: config.maxClaims,
    }));
  } catch {
    return [];
  }
}

export async function worldStats() {
  const empty = { players: 0, claims: 0, structures: 0, tilesCached: 0, tilesServed: 0, surveys: 0 };
  try {
    const [p, c, b, t, s] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(playersTable),
      db.select({ n: sql<number>`count(*)::int` }).from(claimsTable),
      db.select({ n: sql<number>`count(*)::int` }).from(buildingsTable),
      db.select({ n: sql<number>`count(*)::int`, hits: sql<number>`coalesce(sum(${tileCache.hits}),0)::int` }).from(tileCache),
      db.select({ n: sql<number>`count(*)::int` }).from(terrainRegions),
    ]);
    return {
      players: p[0]?.n ?? 0,
      claims: c[0]?.n ?? 0,
      structures: b[0]?.n ?? 0,
      tilesCached: t[0]?.n ?? 0,
      tilesServed: t[0]?.hits ?? 0,
      surveys: s[0]?.n ?? 0,
    };
  } catch {
    return empty;
  }
}

export async function snapshot(pilotId: string | null): Promise<WorldSnapshot> {
  const config = await loadConfig();
  const player = await getPlayer(pilotId);
  if (player) await applyTicks(player.id, config);
  const claims_ = await listClaims({}, config);
  return {
    config,
    player: await getPlayer(pilotId),
    claims: claims_,
    events: await recentEvents(),
    leaderboard: await leaderboard(config),
    stats: await worldStats(),
    serverTime: new Date().toISOString(),
    engine: ENGINE_IDENTITY,
  };
}

export function newId() {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export async function createClaim(input: { playerId: string; lng: number; lat: number; name: string; config: WorldConfigDTO; seedName?: string }) {
  const { playerId, lng, lat, name, config } = input;
  const owned = await db.select().from(claimsTable).where(eq(claimsTable.ownerId, playerId));
  if (owned.length >= config.maxClaims) {
    return { ok: false as const, error: `Claim ceiling reached: ${config.maxClaims} parcels max. Abandon one first.` };
  }
  const id = newId();
  const tile = tileForLngLat(lng, lat, config.tileZoom);
  const survey = surveyParcel(lng, lat, config.claimSizeM, config.gridCells, config.terrainSeed, config.tileZoom);
  // overlapping parcels are rejected: the engine is one-parcel-per-tile-slot
  const clash = owned.find((c) => Math.abs(c.centerLng - lng) < 0.002 && Math.abs(c.centerLat - lat) < 0.002);
  if (clash) return { ok: false as const, error: "That parcel overlaps a parcel you already hold." };

  await db.insert(claimsTable).values({
    id,
    ownerId: playerId,
    name: name.slice(0, 28),
    centerLng: lng,
    centerLat: lat,
    tileZ: tile.z,
    tileX: tile.x,
    tileY: tile.y,
    sizeM: config.claimSizeM,
    status: "active",
    lockedUntil: new Date(Date.now() + config.lockHours * 3600_000),
    defenseScore: Math.round(survey.profile.defenseScore * 100),
    prestige: 1,
    avgElevation: survey.profile.avgElevation,
    avgSlope: survey.profile.avgSlope,
    waterFraction: survey.profile.waterFraction,
    forestFraction: survey.profile.forestFraction,
    farmScore: survey.profile.farmScore,
    buildScore: survey.profile.buildScore,
    biomass: survey.profile.biomass,
    minerals: survey.profile.minerals,
    hydro: survey.profile.hydro,
  });
  await db
    .insert(terrainRegions)
    .values({
      key: `claim:${id}:${config.terrainSeed}:${config.claimSizeM}:${config.gridCells}`,
      z: tile.z,
      x: tile.x,
      y: tile.y,
      seed: config.terrainSeed,
      payload: survey as unknown as Record<string, unknown>,
      cellsEvaluated: survey.cells * survey.cells,
    })
    .onConflictDoNothing();
  await db.update(playersTable).set({ reputation: sql`${playersTable.reputation} + 4` }).where(eq(playersTable.id, playerId));
  await logEvent({ claimId: id, actorId: playerId, type: "claim", message: `Parcel "${name}" surveyed and locked for ${config.lockHours}h at ${lat.toFixed(4)}, ${lng.toFixed(4)}.`, meta: { elevation: survey.profile.avgElevation } });
  return { ok: true as const, id, survey };
}

export async function spendCredits(playerId: string, amount: number) {
  await db.update(playersTable).set({ credits: sql`greatest(0, ${playersTable.credits} - ${Math.round(amount)})` }).where(eq(playersTable.id, playerId));
}

export async function addCredits(playerId: string, amount: number, reputation = 0) {
  await db
    .update(playersTable)
    .set({
      credits: sql`greatest(0, ${playersTable.credits} + ${Math.round(amount)})`,
      reputation: sql`greatest(0, ${playersTable.reputation} + ${Math.round(reputation)})`,
    })
    .where(eq(playersTable.id, playerId));
}

export async function findClaim(id: string) {
  const rows = await db.select().from(claimsTable).where(eq(claimsTable.id, id)).limit(1);
  return rows.length ? rows[0] : null;
}

export async function claimBuildings(id: string): Promise<BuildingDTO[]> {
  try {
    const rows = await db.select().from(buildingsTable).where(eq(buildingsTable.claimId, id));
    return rows.map((b) => ({ id: b.id, kind: b.kind, cellX: b.cellX, cellY: b.cellY, rot: b.rot, level: b.level, integrity: b.integrity }));
  } catch {
    return [];
  }
}

export async function tileMetaFor(key: string) {
  const rows = await db.select().from(tileCache).where(and(eq(tileCache.key, key))).limit(1);
  return rows[0] ?? null;
}
