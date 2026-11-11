import {
  customType,
  pgTable,
  text,
  integer,
  real,
  serial,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

/** postgres bytea, wired through node-postgres Buffer semantics */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/* ------------------------------------------------------------------ *
 * Simplayz persistence layer
 * Every "configurable" knob the product brief mentions lives in the
 * database (world_config) so ops can retune the simulation live.
 * ------------------------------------------------------------------ */

export const worldConfig = pgTable("world_config", {
  id: integer("id").primaryKey().default(1),
  /** edge length of a claimable parcel in metres (1 km² == 1000) */
  claimSizeM: integer("claim_size_m").notNull().default(1000),
  /** how many metres the claim grid is divided into on one axis */
  gridCells: integer("grid_cells").notNull().default(48),
  /** invulnerability window before a parcel can be assaulted */
  lockHours: integer("lock_hours").notNull().default(72),
  /** parcels a single pilot may hold */
  maxClaims: integer("max_claims").notNull().default(3),
  /** OpenStreetMap zoom the engine streams at */
  tileZoom: integer("tile_zoom").notNull().default(15),
  /** upstream raster source consumed by the internal tile streamer */
  tileSource: text("tile_source").notNull().default("https://tile.openstreetmap.org"),
  /** seconds a generated terrain grid stays authoritative before re-hallucination */
  terrainCacheSeconds: integer("terrain_cache_seconds").notNull().default(600),
  /** how long the internal tile streamer keeps a raster tile */
  tileTtlHours: integer("tile_ttl_hours").notNull().default(36),
  /** deterministic seed for the procedural terrain engine */
  terrainSeed: integer("terrain_seed").notNull().default(20770418),
  /** relief multiplier applied to the mesh */
  reliefScale: real("relief_scale").notNull().default(1.35),
  /** economy heartbeat cadence in minutes */
  tickMinutes: integer("tick_minutes").notNull().default(5),
  startCredits: integer("start_credits").notNull().default(9000),
  assaultEnabled: boolean("assault_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  color: text("color").notNull().default("#7df0c0"),
  credits: integer("credits").notNull().default(9000),
  reputation: integer("reputation").notNull().default(0),
  victories: integer("victories").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  homeLng: real("home_lng").notNull().default(13.405),
  homeLat: real("home_lat").notNull().default(52.52),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const claims = pgTable("claims", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").references(() => players.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  centerLng: real("center_lng").notNull(),
  centerLat: real("center_lat").notNull(),
  tileZ: integer("tile_z").notNull(),
  tileX: integer("tile_x").notNull(),
  tileY: integer("tile_y").notNull(),
  sizeM: integer("size_m").notNull().default(1000),
  status: text("status").notNull().default("active"), // active | contested | ruined
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  defenseScore: integer("defense_score").notNull().default(0),
  prestige: integer("prestige").notNull().default(0),
  income: integer("income").notNull().default(0),
  population: integer("population").notNull().default(0),
  // ---- AI terrain engine read-out, frozen at survey time ----
  avgElevation: real("avg_elevation").notNull().default(0),
  avgSlope: real("avg_slope").notNull().default(0),
  waterFraction: real("water_fraction").notNull().default(0),
  forestFraction: real("forest_fraction").notNull().default(0),
  farmScore: real("farm_score").notNull().default(0),
  buildScore: real("build_score").notNull().default(0),
  biomass: real("biomass").notNull().default(0),
  minerals: real("minerals").notNull().default(0),
  hydro: real("hydro").notNull().default(0),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buildings = pgTable("buildings", {
  id: text("id").primaryKey(),
  claimId: text("claim_id")
    .notNull()
    .references(() => claims.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  cellX: integer("cell_x").notNull(),
  cellY: integer("cell_y").notNull(),
  rot: integer("rot").notNull().default(0),
  level: integer("level").notNull().default(1),
  integrity: integer("integrity").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Terrain engine output cache: one authored survey grid per parcel/cell box. */
export const terrainRegions = pgTable("terrain_regions", {
  key: text("key").primaryKey(),
  z: integer("z").notNull(),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  seed: integer("seed").notNull(),
  payload: jsonb("payload").notNull(),
  cellsEvaluated: integer("cells_evaluated").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Internal tile streaming engine cache (OSM raster today, player-authored tomorrow). */
export const tileCache = pgTable("tile_cache", {
  key: text("key").primaryKey(),
  z: integer("z").notNull(),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  png: bytea("png").notNull(),
  byteLen: integer("byte_len").notNull().default(0),
  authored: boolean("authored").notNull().default(false),
  hits: integer("hits").notNull().default(0),
  source: text("source").notNull().default("openstreetmap"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const worldEvents = pgTable("world_events", {
  id: serial("id").primaryKey(),
  claimId: text("claim_id"),
  actorId: text("actor_id"),
  type: text("type").notNull(),
  message: text("message").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorldConfigRow = typeof worldConfig.$inferSelect;
export type PlayerRow = typeof players.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type BuildingRow = typeof buildings.$inferSelect;
export type EventRow = typeof worldEvents.$inferSelect;
