# Simplayz — build-from-scratch prompt

A self-contained specification for reconstructing this application with another AI coding model. Give the whole
document to the model as its task. It is written as instructions, not as documentation: every section is something
the model must implement.

Two companion files are worth reading but are not required to build: `README.md` (why things are the way they are)
and `REVIEW_1.1.md` (enhancement backlog).

---

## 0. Role and mission

You are building **Simplayz**, a persistent browser-based world simulator. Read the whole specification before
writing code. Build in the order given in §14, and read §15 before you start debugging. Do not substitute libraries, do not simplify the terrain model, and
do not skip the acceptance checks in §13.

The product, in one paragraph, is the behavioural contract:

> Simplayz streams real OpenStreetMap raster at zoom 15, then re-hallucinates the surface: relief, drainage, soil,
> canopy and legacy sprawl are synthesised from a seeded field model, stored in Postgres and handed to a three.js
> sector viewer. Pilots lock 1000 m of ground around their own coordinates, raise dwellings, fields, fabs and
> megastructures on a 48×48 grid, then walk what they built in first or third person. Nobody can touch a parcel for
> 72 hours. After that, it is target practice.

---

## 1. Non-negotiable constraints

These are the decisions that define the application. Each one exists because the obvious alternative is worse.
Implement them exactly; if you deviate, state why in the commit message.

1. **The terrain is procedural and seeded, never fetched.** No elevation API, no DEM tile, no heightmap asset.
   Every height, slope, biome and resource value comes from one integer seed. Same seed → same planet, on the
   server, in the browser, in a test.
2. **Postgres is the only source of truth.** Claims, structures, economy, events, the tile cache and the terrain
   survey cache all live in Postgres. The client holds no authoritative state.
3. **The map is rendered flat, but the ground is real.** Terrain is unlit `MeshBasicMaterial` coloured by hue — no
   sun, no shadows, no fog on the surface. Vertices still carry true sampled elevation, so the surface has real
   shape and casts its own silhouette. Colour is data, not light.
4. **The OSM raster is stacked *over* the flat base, never instead of it.** The flat base stays authoritative for
   clicking, placement and provenance. The raster is a semi-transparent drape fetched **through the internal
   streamer** (`/api/tiles`), never directly from OpenStreetMap.
5. **One ground-height function.** A single `localGround(x, z)` feeds terrain vertices, structures, parcels, the
   avatar, the camera and picking. If two code paths compute ground height, the map will drift.
6. **All balance lives in `world_config`.** Claim size, grid, lock hours, seed, relief, tick cadence, start credits.
   Nothing tunable is a constant in a route handler.
7. **Server-authoritative validation.** The client may not place what the server would reject. Share the catalogue
   and the placement rules between both tiers rather than reimplementing them.
8. **Deterministic, hermetic, dependency-light.** No physics engine, no game framework, no animation library. three.js
   for rendering, zustand for state, Drizzle for SQL, and hand-rolled everything else.

---

## 2. Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16, App Router, Turbopack, server route handlers |
| Language | TypeScript 5.9, `strict: true`, no `any` in application code |
| UI | React 19, Tailwind CSS 4 (`@theme inline` + CSS custom properties) |
| 3D | three.js 0.187 (`MeshBasicMaterial` for terrain, `MeshLambertMaterial` for structures) |
| State | zustand 5 (one world store, one theme store) |
| DB | PostgreSQL via `pg` 8.20 + `drizzle-orm` 0.45 |
| Path alias | `@/*` → `src/*` |

Initialise with `npx create-next-app@latest` (TypeScript, Tailwind, App Router, no `src/` nesting beyond `src/app`),
then add `three @types/three zustand drizzle-orm pg` and `-D drizzle-kit @types/pg`.

`next build` **requires `POSTGRES_URL` to exist** in the environment even when the database is unreachable. Build
with a dummy value in CI: `POSTGRES_URL="postgres://x:y@127.0.0.1:5432/x" npx next build`.

---

## 3. File layout

Create exactly this structure. Line counts are from the reference implementation — they are a sanity check, not a
target.

```
src/
  app/
    layout.tsx                     # root layout + THEME_BOOT inline script
    globals.css                    # CSS custom properties, @theme inline, .panel utility
    page.tsx                       # landing page (~310)
    theme-store.ts                 # zustand theme store (~146)
    theme-host.tsx                 # applies the active theme to :root
    world/
      page.tsx                     # /world shell, HUD composition (~133)
      viewport.tsx                 # the whole three.js engine (~1512)
      panels.tsx                   # HUD panels (~1200)
      store.ts                     # world zustand store (~336)
      use-event-stream.ts          # SSE notifications (~90)
    api/
      world/route.ts               # GET snapshot
      player/route.ts              # GET/POST pilot identity
      claims/route.ts              # POST claim lifecycle
      buildings/route.ts           # POST place/demolish/upgrade/repair
      terrain/route.ts             # GET parcel survey
      config/route.ts              # GET/PATCH world config
      tiles/[z]/[x]/[y]/route.ts   # GET raster tile, DB-cached (~179)
      stream/route.ts              # GET SSE notifications (~110)
      health/route.ts              # GET liveness
  db/
    index.ts                       # pg Pool + drizzle client
    schema.ts                      # all tables (~155)
  engine/
    geo.ts                         # slippy-map maths, SectorFrame (~145)
    terrain.ts                     # noise, height, classification, survey (~379)
    buildings.ts                   # structure catalogue (~417)
    simulation.ts                  # placement, totals, assault, lock (~280)
    palette.ts                     # flat map painter, ramps (~287)
    themes.ts                      # glass themes (~415)
  lib/
    server.ts                      # all DB access (~573)
    types.ts                       # shared DTOs (~110)
    theme.ts                       # theme → CSS variables, contrast maths
```

**Rule:** `src/engine/**` is pure and importable from both tiers. It must never import `pg`, `next` or `react`.

---

## 4. Data model

Drizzle, `drizzle-kit generate` to emit SQL. Use plain `npx drizzle-kit generate` — the `--out` flag misbehaves.

```ts
world_config     id int pk default 1,
                 claim_size_m int 1000, grid_cells int 48, lock_hours int 72,
                 max_claims int 3, tile_zoom int 15,
                 tile_source text 'https://tile.openstreetmap.org',
                 terrain_cache_seconds int 600, tile_ttl_hours int 36,
                 terrain_seed int 20770418, relief_scale real 1.35,
                 tick_minutes int 5, start_credits int 9000,
                 assault_enabled bool true, updated_at timestamptz

players          id text pk, handle text, color text, credits int 9000,
                 reputation int, victories int, losses int,
                 home_lng real, home_lat real, created_at, last_seen_at

claims           id text pk, owner_id → players(id) cascade, name text,
                 center_lng real, center_lat real,
                 tile_z int, tile_x int, tile_y int,
                 size_m int 1000, status text 'active',   -- active|contested|ruined
                 locked_until timestamptz,
                 defense_score int, prestige int, income int, population int,
                 -- terrain read-out frozen at survey time:
                 avg_elevation real, avg_slope real, water_fraction real,
                 forest_fraction real, farm_score real, build_score real,
                 biomass real, minerals real, hydro real,
                 last_tick_at timestamptz default now, created_at, updated_at

buildings        id text pk, claim_id → claims(id) cascade, kind text,
                 cell_x int, cell_y int, rot int, level int default 1,
                 integrity int default 100, created_at

terrain_regions  key text pk, z int, x int, y int, seed int,
                 payload jsonb, cells_evaluated int, created_at
                 -- the survey grid, so a parcel is never re-hallucinated per view

tile_cache       key text pk, z int, x int, y int, png bytea, byte_len int,
                 authored bool default false, hits int default 0,
                 source text, fetched_at timestamptz, expires_at timestamptz

world_events     id serial pk, claim_id text, actor_id text, type text,
                 message text, meta jsonb, created_at
```

Index `world_events(claim_id)` and `world_events(actor_id)` — the notification stream queries both.
`world_config` is a single row: seed it with `onConflictDoNothing` and fall back to in-code defaults if the DB is
unreachable, so the app renders offline.

---

## 5. Geodesy (`src/engine/geo.ts`)

Slippy-map maths shared by the streamer, terrain engine and renderer.

```ts
TILE_PX = 256
ORIGIN_SHIFT = 20037508.342789244
clampLat(lat)                  // ±85.05112878
lngLatToMerc / mercToLngLat    // normalised 0..1
tileSizePx(z) = TILE_PX * 2**z
lngLatToTileF(lng, lat, z)     // fractional tile coords
tileFToLngLat(fx, fy, z)
tileForLngLat(lng, lat, z)     // integer {z,x,y}
lngLatToWorldM(lng, lat)       // Web Mercator metres
metersPerPixel(lat, z)         // 156543.03392 * cos(lat) / 2**z
offsetLngLat(lng, lat, dxM, dyM, z)   // local metres → coordinate
```

Then a `SectorFrame` class — the planar frame the whole renderer works in:

```ts
new SectorFrame(centerLng, centerLat, z, tilesWide = 3)
  .z .mPerPx .tilePx .sizeM          // sizeM = tilePx * mPerPx
  .originTileX .originTileY .centerLng .centerLat
  .localToLngLat(x, y)               // metres, east+/south+ → coordinate
  .lngLatToLocal(lng, lat)
  .tileLocal(tx, ty)                 // tile → metre offset from frame origin
```

**Watch the constructor order: `(lng, lat, z)`.** Getting it backwards silently yields `NaN` everywhere and a
completely blank scene.

At zoom 15 near the equator one tile is ~1216 m across, so a 3×3 sector is ~3.6 km. Treating metres-per-pixel as
constant inside one sector is accurate to well under 1% and keeps the three.js maths trivial.

---

## 6. Terrain engine (`src/engine/terrain.ts`)

Pure, no I/O. This is the heart of the product.

### 6.1 Noise primitives

```ts
h2(ix, iy, seed)      // integer hash → 0..1, via Math.imul mixing (0x27d4eb2d, 0x165667b1, 0x9e3779b1,
                      //   0x85ebca6b, 0xc2b2ae35). Deterministic across platforms: use Math.imul, not floats.
fade(t) = t³(t(6t-15)+10)
sstep(a, b, x)        // smoothstep, clamped
vnoise(x, y, seed)    // bilinear value noise with fade weights, 0..1
fbm(x, y, seed, octaves=5, lacunarity=2.02, gain=0.5)
ridged(x, y, seed, octaves=5)   // sum of (1-|2n-1|)² with amp *= 0.52, freq *= 2.07
```

### 6.2 The height field

`heightAtM(X, Y, seed)` — **input is projected-Mercator metres, not lng/lat.** Returns metres above the water datum.
Reproduce these terms in this order; the constants are load-bearing:

```
warp:     qx = X + (fbm(X·0.00016, Y·0.00016, seed+11, 3) - 0.5)·1500
          qy = Y + (fbm(X·0.00016, Y·0.00016, seed+29, 3) - 0.5)·1500
base:     b  = fbm(qx·0.00028, qy·0.00028, seed, 5);  t = (b-0.5)·2
          h  = 20 + (t < 0 ? t·20 : t·118·(1 + 0.8·|t|^2.1))
          # +20 datum bias with a compressed downside: the planet is mostly
          # dry land; water arrives through carving, not the base field.
mountains: m  = ridged(qx·0.00033, qy·0.00033, seed+7, 5)
          h += (max(0, m-0.6)/0.4)^1.4 · 330
fluvial:  rline = |fbm(X·0.00021+13.7, Y·0.00021-4.3, seed+57, 4)·2 - 1|
          river = 1 - sstep(0, 0.05, rline)
          if (h > -6) h -= river·(20 + 26·sstep(0,130,h))·(1 - sstep(150,400,h))
lacustrine: wetRaw = fbm(X·0.0009, Y·0.0009, seed+808, 4)
          lake = sstep(0.82, 0.95, wetRaw)·(1 - river·0.2)
          if (h < 22 && h > -10) h -= lake·(9 + 12·lake)
detail:   h += (fbm(X·0.0058, Y·0.0058, seed+3, 3) - 0.5)·4.2
clamp:    h ∈ [-46, 920]
```

Expected global range is roughly −46..920 m, with the **minimum around −15 m** — open water is rare and shallow by
design. Consequence: most random coordinates are land with 100–350 m of local relief. Verify this once with a
script; do not tune it by eye.

### 6.3 Derived signals

`riverMaskM(X, Y, seed)` — same `rline` field with a wider `sstep(0, 0.07, ·)`.

`sampleAt(X, Y, seed, lat)` and `sampleTerrain(lng, lat, seed)` return:

```ts
{ h, slopeDeg, wet, temp, forest, urban, river, biome }
```

- `slopeDeg` — central differences at ±9 m, divided by `mercatorScale(lat)` so slopes are ground-true, not
  Mercator-inflated. **Do not skip this division**; slopes at high latitude will be wildly wrong.
- `wet` — `fbm(·0.0009, seed+808)·0.72 + river·0.45 + sstep(16,-3,h)·0.4`, clamped.
- `temp` — latitude factor plus an elevation penalty, `latFactor·0.62 + 0.38·(1-sstep(180,720,h)) - sstep(0.75,1,wet)·0.12`.
- `forest` — canopy noise gated by `sstep(0,7,h)` (no trees at the shoreline), `sstep(430,250,h)` (treeline) and
  suppressed on steep ground.
- `urban` — "town gravity": city-pull noise gated by flatness and by `sstep(-3,9,h)`.

`quickSample(lng, lat, seed)` is the cheap variant for the renderer: same height and colour signals but fewer
octaves and a one-sided slope. It exists so 26×26 vertices × 9 tiles stay interactive.

### 6.4 Biomes

Fourteen classes, indexed — the index is stored in the survey grid, so order matters:

| id | key | name | fertility | cover | walk | costMod | buildable |
|---|---|---|---|---|---|---|---|
| 0 | abyss | Deep Water | 0 | 0.20 | 0.20 | 9.0 | no |
| 1 | shelf | Shallow Water | 0.10 | 0.30 | 0.30 | 7.0 | no |
| 2 | marsh | Reed Marsh | 0.45 | 1.15 | 0.60 | 1.70 | yes |
| 3 | sand | Sandflat | 0.15 | 0.70 | 0.85 | 1.00 | yes |
| 4 | plains | Open Plains | 0.80 | 0.85 | 1.00 | 0.85 | yes |
| 5 | meadow | Lush Meadow | 1.00 | 0.95 | 1.00 | 0.90 | yes |
| 6 | woodland | Woodland | 0.70 | 1.25 | 0.80 | 1.10 | yes |
| 7 | oldgrowth | Old Growth | 0.60 | 1.45 | 0.65 | 1.25 | yes |
| 8 | scrub | Scrub Steppe | 0.50 | 1.00 | 0.95 | 0.90 | yes |
| 9 | rock | Rockfield | 0.15 | 1.35 | 0.60 | 1.40 | yes |
| 10 | scree | Cliff & Scree | 0.10 | 1.50 | 0.45 | 1.65 | yes |
| 11 | snow | Snowfield | 0.05 | 0.80 | 0.55 | 1.80 | yes |
| 12 | sprawl | Legacy Sprawl | 0.20 | 1.20 | 1.00 | 1.15 | yes |
| 13 | garden | Garden Belt | 0.95 | 1.05 | 1.00 | 0.95 | yes |

`classify(h, wet, temp, slope, urban, forest)` — evaluate **in this order, first match wins**:

```
h < -7                                    → 0 abyss
h < 1.5                                   → 1 shelf
h < 8 && wet > 0.66                       → 2 marsh
temp < 0.2 && h > 150                     → 11 snow
h > 380 || (slope > 34 && h > 160)        → 10 scree
h > 230 && slope > 16                     → 9 rock
slope > 22                                → 9 rock
urban > 0.45                              → 12 sprawl
wet > 0.62 && h < 12                      → 2 marsh
forest > 0.62                             → 7 oldgrowth
forest > 0.32                             → 6 woodland
wet > 0.44 && temp > 0.35                 → 5 meadow
temp > 0.5 && wet < 0.3                   → 8 scrub
h < 20 && wet > 0.3                       → 13 garden
wet < 0.22 && h < 60                      → 3 sand
default                                   → 4 plains
```

### 6.5 Parcel survey

`surveyParcel(centerLng, centerLat, sizeM, cells, seed, zoom) → SurveyResult`

For every cell centre, sample and accumulate:

```ts
grid[i] = { y: round(h, 0.05), b: biomeId, ok: 0|1|2 }   // 0 = unsupported, 1 = clear, 2 = costly slope
                                                          // ok = 2 when slopeDeg > 20
avgElevation, avgSlope, maxElevation
waterFraction   // unbuildable biome or h < 1.5
forestFraction  // biomes 6,7
urbanFraction   // biome 12
farmScore   += fertility · (h > 2 && slope < 9 ? 1 : 0.25)
buildScore  += (buildable && slope < 14 ? 1 : 0.15) / max(0.6, costMod)
defenseScore+= 0.5 + slope/30 + cover·0.35
biomass     += fertility · (0.4 + forest)
minerals    += sstep(30,300,h)·0.7 + sstep(18,2,wet)·0.3 + (rock||scree ? 0.6 : 0)
hydro       += (river > 0.4 ? 0.8 : 0) + sstep(10,0,h)·0.5 + wet·0.35
histogram   // biome shares, descending
```

A 48×48 survey is 2304 samples; cache the result in `terrain_regions` keyed by `z/x/y/seed` with a TTL from
`terrain_cache_seconds`.

---

## 7. Structure catalogue (`src/engine/buildings.ts`)

One shared array — the palette UI, the mesh factory and the server validator all read it. Implement all eighteen:

```
key          | name              | cat      | cost | upkeep | footprint | floorH×storeys | roof   | pop | inc | food | power | def | pres
dwelling     | Pod Dwelling      | habitat  |  320 |      4 | 2×2       | 3.2×1          | pitch  |   6 |   9 |    0 |    -2 |   0 |    1
apartment    | Terrace Block     | habitat  | 1450 |     16 | 3×5       | 3.1×5          | flat   |  60 |  46 |    0 |    -9 |   0 |    6
farm         | Field Strip       | food     |  240 |      2 | 4×2       | 0.2×1          | none   |   3 |   6 |   26 |     0 |   0 |    0
orchard      | Orchard Terrace   | food     |  420 |      3 | 3×3       | 2×1            | none   |   2 |   4 |   18 |     0 |   0 |    1
greenhouse   | Hydro Vault       | food     | 1180 |     18 | 3×2       | 3.6×1          | panels |   5 |  12 |   44 |   -14 |   0 |    4
road         | Service Road      | network  |   70 |      1 | 1×2       | 0.06×1         | none   |   0 |   2 |    0 |     0 |   0 |    0
junction     | Interchange       | network  |  640 |      6 | 3×3       | 0.12×1         | none   |   0 |  14 |    0 |    -2 |   0 |    3
warehouse    | Logistics Shed    | industry |  820 |      8 | 4×3       | 5.2×1          | flat   |   8 |  30 |    0 |    -5 |   2 |    2
factory      | Fab Line          | industry | 1750 |     22 | 5×4       | 6.4×1          | panels |  24 |  78 |    0 |   -22 |   3 |    5
market       | Bazaar Deck       | commerce |  980 |     10 | 3×3       | 4×1            | pitch  |   6 |  54 |    4 |    -4 |   0 |    5
mall         | Megastructure Mall| commerce | 3400 |     34 | 6×5       | 4.6×3          | dome   |  12 | 168 |    8 |   -28 |   4 |   18
solar        | Photon Field      | industry |  700 |      3 | 4×2       | 1.1×1          | panels |   1 |  10 |    0 |    34 |   0 |    1
watchtower   | Watch Spire       | defense  |  900 |      8 | 2×2       | 7×2            | flat   |   3 |   0 |    0 |    -6 |  26 |    4
wall         | Blast Berm        | defense  |  210 |      1 | 1×3       | 3.4×1          | none   |   0 |   0 |    0 |     0 |  11 |    0
medbay       | Med Bay           | civic    | 1250 |     14 | 3×3       | 3.8×2          | flat   |   6 |  22 |    0 |   -12 |   3 |    9
academy      | Academy           | civic    | 1980 |     20 | 4×4       | 4.2×2          | pitch  |  14 |  40 |    0 |   -11 |   2 |   14
park         | Terrace Park      | luxury   |  380 |      5 | 3×3       | 0.4×1          | none   |   0 |   8 |    2 |     0 |   1 |    7
beacon       | Claim Beacon      | civic    | 2600 |     24 | 2×2       | 12×1           | dome   |   2 |  30 |    0 |   -20 |  16 |   30
```

Each also has `blurb` (one sentence, in-world voice), `needsRoad?` (sheds, fabs, civic, commerce) and `minFarm?`
(food kinds). Give every kind a colour; keep them distinguishable at 48 cells across 1 km.

Helpers: `footprintCells(kind, x, y, rot, cells)` (rotation-aware, returns `null` on boundary crossing),
`occupancy(buildings, cells)`, `hasRoadAccess`, `upgradeCost = round(cost·0.7·1.55^level)`,
`buildingHeight`, `effectiveHeight`, `footprintFor(kind, rot)`.

---

## 8. Simulation (`src/engine/simulation.ts`)

### 8.1 Placement

`checkPlacement(kind, x, y, rot, cells, buildings, survey, credits)` returns `{ok, cost, costMod, reason}`.
Reject: footprint outside the grid → occupied cell → `ok === 0` ground → farm score below `kind.minFarm` →
insufficient credits. `costMod` is the **max** biome `costMod` across the footprint, multiplied by **1.6** if any
cell is `ok === 2` (steep). Final cost is `round(kind.cost · costMod)`.

### 8.2 Aggregate totals

`computeTotals(buildings, survey, cells) → {structures, occupied, population, income, upkeep, netIncome, food,
power, defense, prestige, disconnected}`

```
connectivity = 1 + min(0.35, junctions·0.07)
per structure:  scale = 1 + (level-1)·0.55;  integrity = max(0.15, integrity/100)
                served = needsRoad ? hasRoadAccess : true
                eff = (served ? 1 : 0.35) · scale · integrity
                soil  = max over footprint of (0.4 + biome.fertility·0.8)
                cover = max over footprint of biome.cover
                population += round(kind.population · eff · (served ? 1 : 0.6))
                income     += kind.income · eff · connectivity · (food ? soil : 1)
                upkeep     += kind.upkeep · scale
                food       += kind.food · eff · soil
                power      += kind.power · (power > 0 ? scale : 1)
                defense    += kind.defense · scale · cover · integrity
                prestige   += kind.prestige · scale
defense = round((defense·10 + 40) · (0.75 + survey.defenseScore·0.22))
netIncome = clamp(round(income - upkeep), -60, ∞)
```

A structure with `needsRoad` and no adjacent road is added to `disconnected` and produces 35%.

### 8.3 The economy tick

`applyTicks(playerId, config)` — lazy, per claim, no cron:

```
interval = max(1, tickMinutes) · 60_000
ticks    = floor((now - claim.lastTickAt) / interval);  skip if <= 0
delta   += totals.netIncome · min(ticks, 48)            // 48-tick cap: an abandoned parcel
                                                        // cannot farm a year of income
set lastTickAt = now;  credits = greatest(0, credits + delta)
```

Run it inside `snapshot()` before returning, so a pilot's balance is current the moment they load the page.
**Do not add a background worker.** The lazy model has no lock, no double-credit on concurrent reads, and works
when the process restarts.

### 8.4 Assault

Only possible after `lockedUntil` has passed and only if `assault_enabled`. Deterministic from a seed:

```
mobilisation = clamp(attackerCredits / 9000, 0.12, 0.85)
momentum     = 1 + min(0.6, attackerReputation / 420)
roll(n)      = frac(sin(seed·12.9898 + n·78.233) · 43758.5453)
phases       = RECON, BREACH, HOLD, FLAG   (roll 1..4, each with a note)

attackerPower = round(60 + mobilisation·240·momentum + roll(1)·70)
defenderPower = round(defenseScore · (0.85 + roll(2)·0.4) · (0.8 + terrainDefense·0.25) + 30)
holdScore     = roll(3)·(attackerPower - defenderPower) + (attackerClaims < 3 ? 24 : 0)
margin        = attackerPower - defenderPower + holdScore·0.35 + roll(4)·100·0.15
success       = margin > 0

loot = success ? round(min(credits·0.4, 400 + prestige·26 + defenderPower·1.6))
               : -round(min(credits·0.18, 220 + attackerPower·0.3))
reputation = success ? +round(18 + prestige·0.6) : -round(9 + defenderPower/40)
```

On success transfer `ownerId`, reset `lockedUntil` to a fresh `lockHours`, set `status = 'contested'`, and log an
event. Return the full `AssaultReport` including `phases` — the UI renders it as an after-action diagram.

`lockCountdown(lockedUntil, now)` returns `{remaining, open, label}` — `OPEN`, or a countdown such as `71h 12m`.

---

## 9. Flat map painter (`src/engine/palette.ts`)

Colour is data. Three ramps, each a low→high pair interpolated by a factor:

```ts
CARTO = { waterLow:"#052a4e", waterHigh:"#4bb8f0",
          sandLow:"#57524a",  sandHigh:"#d3cdbf",
          landLow:"#1b7a43",  landHigh:"#e9f6d8" }
```

`classifyLand(input)` — **reuse this everywhere**, including for pinning water vertices in the renderer:

```
h < 1.5                              → water
biome in {abyss, shelf}              → water
h < 8 && wet > 0.66                  → water
h < 7.5                              → sand
biome in {2,3}                       → sand
h < 14 && wet > 0.62                 → sand
otherwise                            → land
```

Factors:

```
waterFactor = clamp(((h+22)/26)·0.7 + (0.55 + 0.3·wet + 0.15·min(1, river·2))·0.3)
sandFactor  = clamp(((h-1.5)/8)·0.75 + (1-wet)·0.25)
landFactor  = clamp(pow(clamp((h-7)/300), 1.25)·0.94 + 0.06 + (canopy·built - 1)·0.12)
              where canopy = 1 - min(1, forest·0.55),  built = 1 - min(1, urban·0.30)
```

**`landFactor`'s elevation band is 7–300 m, not the terrain's full range.** Because the field sits mostly between
100 and 350 m, a wider band washes every hill into one flat colour. This exact gamma (`^1.25`) was reached after
two failed attempts; keep it.

`paintFlatColor(palette, input)` returns sRGB bytes ready for vertex colours. `swatches()`, `contrastRatio()`,
`mixRgb()`, `hexToRgb()` support the theme picker.

---

## 10. Themes (`src/engine/themes.ts`, `src/lib/theme.ts`)

Five selectable looks, all glassmorphism. **All of them must be user-selectable in a HUD modal** — this is a hard
product requirement, not a nice-to-have.

| id | name | surface | scheme |
| --- | --- | --- | --- |
| cartographer | Cartographer | `#04070a` void, mint HUD | dark |
| violet | Violet Nocturne | `#0e0a1a` indigo | dark |
| lilac | Lilac Daylight | `#efe9fa` paper lilac | light |
| custom | Custom | pilot's chosen ground | inferred |
| chaos | Chaos | randomised, readability-checked | either |

`ThemeColors` carries exactly these tokens: `void hull glass panel line ink dim faint mint amber ice rose
onAccent scheme`. Each theme also supplies `glow: [string, string]` for the landing-page wash and `map: MapPalette`
for the "themed" map style.

The custom theme infers its scheme from ground luminance and contrast-corrects its accent. Chaos generates two
well-separated anchor hues, then **rejects and re-rolls until `isReadableTheme()` passes** — a full contrast ladder, not a single number:

```
contrastRatio(ink,   void) >= 7      // primary text
contrastRatio(dim,   void) >= 4.5    // muted text
contrastRatio(faint, void) >= 3      // telemetry
contrastRatio(mint,  void) >= 4.5    // primary accent
contrastRatio(amber, void) >= 4
contrastRatio(ice,   void) >= 4
contrastRatio(rose,  void) >= 4
```

The glass panes lower the effective ratio slightly, so the bars sit above the strict WCAG minimum for accents that
carry meaning. In the reference implementation 200 generated chaos themes all passed; if yours fail, the generator
is wrong, not the threshold.

### Theme delivery

CSS custom properties apply at runtime; Tailwind 4 cannot emit per-theme utilities for a runtime choice, so:

1. `globals.css` declares `--color-*` defaults on `:root` and re-exposes them via `@theme inline`.
2. `applyThemeVars(theme)` writes the active theme's values onto `document.documentElement.style`.
3. `layout.tsx` injects `THEME_BOOT`, an inline `<script>` that replays the persisted variables **before React
   mounts**, so a reload never flashes the default theme.
4. One `.panel` utility is the entire glass surface: translucent tint + `backdrop-filter` + hairline edge.

Tailwind classes therefore stay theme-agnostic (`text-ink`, `bg-glass`, `border-line`) and repaint live.

---

## 11. API contracts

Every route: `export const dynamic = "force-dynamic"`. JSON responses are `{ok: boolean, ...}`. The pilot id
travels in a header or query param and is a bearer token with no password — do not invent an auth system, but do
understand that it is not secure.

| Route | Method | Body / query | Returns |
| --- | --- | --- | --- |
| `/api/world` | GET | `?pilot=` | `WorldSnapshot` — config, player, claims, events, leaderboard, stats, `serverTime`, `engine` identity |
| `/api/player` | POST | `{handle?, home?}` | `{pilotId, player}` — registers or updates; handle is derived from a sha1 of the seed |
| `/api/player` | GET | `?pilot=` | the pilot, if it exists |
| `/api/claims` | POST | `{action: claim\|abandon\|rename\|assault\|relock\|jump, claimId?, name?, lng?, lat?}` | `{ok, claim?}` |
| `/api/buildings` | POST | `{action: place\|demolish\|upgrade\|repair, claimId?, buildingId?, kind?, cellX?, cellY?, rot?}` | `{ok, claim?}` |
| `/api/terrain` | GET | `?lng=&lat=&seed=` | `SurveyResult` for the parcel |
| `/api/config` | GET/PATCH | partial `WorldConfigDTO` | the full config. **PATCH is currently unauthenticated** — see §15 |
| `/api/tiles/:z/:x/:y` | GET | `?purge=1` | PNG + provenance headers |
| `/api/stream` | GET | `?pilot=&since=` | SSE |
| `/api/health` | GET | — | liveness + DB reachability |

### The tile streamer

Not optional, and not a passthrough. It is an internal cache with provenance:

- Look up `tile_cache` by `z/x/y`. Fresh and not purging → serve from cache, increment `hits`, report
  `x-simplayz-tile-source: cache`.
- Otherwise fetch `tileSource` upstream with a browser-like `User-Agent` (OSM rejects default clients). Store the
  PNG plus `expiresAt = now + tileTtlHours`.
- Upstream failure with a cached-but-expired tile → serve the stale tile with `source: stale`.
- Upstream failure with nothing cached → serve a **hand-built PNG** with no dependencies
  (`source: generated`), so a cold offline start still renders.
- Prune with FIFO once `MAX_CACHED_TILES = 4000` is exceeded, dropping 500.
- Headers on every response: `x-simplayz-tile-source` (`cache|origin|stale|generated`),
  `x-simplayz-tile-key`, `x-simplayz-tile-hits`, `x-simplayz-overlay` (`raw` or
  `player-authored:<n>parcel/<n>structures`).
- `cache-control: public, max-age=ttl·3600, stale-while-revalidate=86400` — **except** for `generated`, which
  must be `no-store`. A placeholder cached for 36 hours at a CDN edge is a 36-hour blank map.
- `?purge=1` must **delete the row**, not merely skip the read.
- Reject non-integer `z` — `15.5/x/y` would create a cache key that can never be hit again.

### The notification stream

`GET /api/stream?pilot=…&since=…` returns `text/event-stream`.

- Poll every 3 s, heartbeat comment every 15 s, `x-accel-buffering: no`, `no-transform`.
- Emit `event: ready` with the cursor, then `event: event` per row.
- `eventsForPilot(pilotId, afterId)` matches on **`claimId` ∈ parcels the pilot owns, OR `actorId` = the pilot**.
  A global "last 18 events" tail is the wrong feed: in a busy world it pushes your own assault notice off the end
  before you see it.
- This is a **notification** channel, not a source of truth. The client calls `refresh()` on receipt; the 25 s
  poll stays as resync. A dropped stream must degrade, never freeze the world.
- `EventSource` reconnects but cannot resume from a cursor, so the client reconnects by hand with `since` and
  exponential backoff.

---

## 12. Renderer (`src/app/world/viewport.tsx`)

A single imperative `SimplayzEngine` class. React owns only its lifecycle and passes an `EngineView` down through
`update()`.

### 12.1 Sector model

3×3 tiles at zoom 15, `TILES_WIDE = 3`, `SEG = 26` segments per tile. Geometry is rebuilt only when
`terrainSeed` changes; colours repaint in place when the palette changes (`paletteKey` diff) — that is what makes
live theme switching cheap.

### 12.2 The base surface

```ts
geo = PlaneGeometry(size, size, SEG, SEG).rotateX(-π/2)
for each vertex:  lngLat = frame.localToLngLat(ox + x, oz + z)
                  s = quickSample(...)
                  water = classifyLand(s) === "water"
                  y = water ? 0 : max(0, s.h) · reliefScale      // ← flat water, real land
                  colour = paintFlatColor(palette, s)
material = MeshBasicMaterial({vertexColors: true})                // unlit: colour is data
mesh.position = (tileOffset.x + size/2, 0, tileOffset.y + size/2)
```

Two details that are easy to get wrong and very visible when you do:

- **Pin water to `y = 0`.** Lake beds and shoreline dunes would otherwise ripple the coastline. Use the shared
  `classifyLand()` predicate; a second inline copy will drift from the painter.
- **Place one translucent water plane at `y = 0.05`** across the whole sector. Terrain displaced below the datum
  is otherwise bare sky under the shore.

With `reliefScale = 1.35`, Jakarta's sector shows ~105 m of relief and Bandung ~310 m — roughly a 1:10 vertical
ratio over 3.6 km. Dramatic enough to read as terrain from the bird camera without becoming a canyon.

### 12.3 The stacked raster

One plane per tile, fetched through the streamer:

- Subdivide to the **same `SEG` as the base** so vertices align, and displace each vertex to
  `localGround(...) + 2.5`. A flat plane will slice through hillsides.
- `MeshBasicMaterial({transparent: true, depthWrite: false, polygonOffset: -1/-1})`.
- `fetch("/api/tiles/…")` → `blob()` → `createImageBitmap()` → `THREE.Texture` with `SRGBColorSpace`. Use `fetch`
  rather than `<img>` so the provenance headers are readable.
- Three modes: **FLAT** (no network), **STACK** (raster at `tileOpacity`, default 0.55), **RASTER** (full
  strength). Opacity changes must not rebuild geometry.
- Abort in-flight fetches on sector rebuild and `.close()` bitmaps that resolve after their sector is gone.
- When switching FLAT → STACK after panning in FLAT, backfill only the tiles **missing** an overlay — not "if
  there are no overlays at all", which leaves the panned-in tiles blank.

### 12.4 One ground function

```ts
localGround(lx, lz) {
  const ll = this.frame.localToLngLat(lx, lz);
  return heightAtLngLat(ll.lng, ll.lat, this.seed) · this.reliefScale;
}
```

Terrain vertices, structures, parcel fills, the avatar, the camera clamp and the picking marcher all call it. This
single function is why structures sit on slopes without any per-object special-casing.

### 12.5 Everything that must sit on the ground

Parcel fills (a 12×12 subdivided plane following `localGround`), boundary ribbons (resampled along the perimeter
so the outline hugs the relief), lock domes, label sprites, structures, the ghost preview, the avatar and the tour
camera. When relief was added, all of these followed automatically because they already called `localGround`. If
you find yourself writing a second height sampler, stop.

### 12.6 Picking

`groundPoint()` raycasts the tile meshes — with real geometry this works. But a ray can pass over a summit and
miss entirely when looking along a ridge, so add a heightfield marcher as a fallback: 12 m steps to 480 m, then
eight bisection refinements.

### 12.7 Camera modes

`Mode = "bird" | "build" | "fps" | "tps"`. Bird/build orbit a target with yaw/pitch/distance. FPS/TPS take pointer
lock and walk: `speed` modulated by `BIOMES[biome].walk`, gravity and a jump, and the camera clamped to
`localGround(desired.x, desired.z) + 12` so it can never enter a hill.

### 12.8 Sky, stars, grid

Minimal on purpose. A vertical gradient sky, a star field, and a 250 m grid that **follows the relief** and is
rebuilt per sector — its heights are baked into the vertices, so it must not also slide with the camera.

### 12.9 Telemetry

`{fps, draws, tris, tiles, alt, speed, layers, tileSource, overlay, tileOpacity}` — the HUD reads all of it, and
`emitTelemetry()` must be a no-op after `dispose()`.

---

## 13. Acceptance checks

Run these before declaring the build done. Each one caught a real bug in the reference implementation.

**Determinism**
```ts
surveyParcel(106.8456, -6.2088, 1000, 48, 20770418, 15) // twice → identical grid, byte for byte
```

**Relief is real, and water is flat**
```ts
// Jakarta:   land relief 25..130 m     Bandung: 22..332 m
// at (140, 32): 73% water pinned to y = 0, land 5..79 m
```
If your coastal sector shows no water at all, check that `heightAtM` receives Mercator metres and that
`classifyLand` — not a hand-written predicate — is deciding.

**The tile streamer survives the database being down**
```
GET /api/tiles/15/17605/10749  →  200 image/png, x-simplayz-tile-source: generated,
                                  cache-control: no-store
GET /api/tiles/15.5/100/100    →  400
GET /api/tiles/2/9/1           →  400
GET /api/tiles/15/17605/10749?purge=1 → 200 (and the row is gone)
```

**The stream degrades without a database**
```
GET /api/stream                  →  400 pilot id required
GET /api/stream?pilot=x          →  200 text/event-stream, x-accel-buffering: no,
                                    "event: ready" frame within one second
```

**Theme legibility** — generate 200 chaos themes and assert every one passes `isReadableTheme()`. Then assert each
named theme's ink-to-void ratio. Reference: violet 16.39:1, lilac 13.72:1.

**Build health**
```
npx tsc --noEmit          # clean
npx eslint .              # no new errors
POSTGRES_URL=dummy npx next build   # succeeds; /api/stream must be listed as dynamic
curl /            → 200
curl /world       → 200
```

---

## 14. Build order

Follow this sequence. Each step is verifiable on its own, and each later step depends on the earlier ones being
correct.

1. **Scaffold + schema.** Next.js, Drizzle schema, `db/index.ts`, `POSTGRES_URL` fallback, config seed.
2. **Geodesy + terrain.** `geo.ts`, `terrain.ts`, `palette.ts`. Verify determinism and the relief ranges with a
   script before any pixels exist. This is the foundation; a mistake here is invisible until much later.
3. **Catalogue + simulation.** `buildings.ts`, `simulation.ts`. Unit-check `computeTotals` and `checkPlacement`
   against a hand-built parcel.
4. **Server.** `lib/server.ts` and every route except the stream. Curl each endpoint.
5. **Tile streamer.** Cache, provenance, placeholder, validation. Test with the database down.
6. **Renderer.** `viewport.tsx` — flat base first, relief second, picking third, modes last. Screenshot each stage.
7. **HUD.** `panels.tsx`, `store.ts` — telemetry, minimap, build palette, parcel inspector, config panel.
8. **Themes.** `themes.ts`, `lib/theme.ts`, `globals.css`, `THEME_BOOT`. Verify no flash on reload.
9. **Notifications.** `/api/stream`, `use-event-stream.ts`, per-pilot scoping, backoff.
10. **Polish.** Landing page, advisor agent, assault report, onboarding, help.

---

## 15. Traps

Collected from building this once. Expect to hit most of them.

| Symptom | Cause |
| --- | --- |
| Blank scene, no errors | `SectorFrame(lat, lng, z)` — the constructor is `(lng, lat, z)` |
| Everything is NaN | `NaN` propagates from one bad `localToLngLat`; check the frame before the renderer |
| Slopes absurd at high latitude | `slopeDeg` not divided by `mercatorScale(lat)` |
| Map washed out, one flat colour | `landFactor` elevation band too wide — it must be 7–300 m with `^1.25` |
| Rippled coastlines | water vertices not pinned to `y = 0` |
| Raster slices through hills | overlay not subdivided to `SEG` and displaced |
| Structures float above ground | a second height sampler; delete it and call `localGround` |
| Blank map stuck at a CDN | the `generated` placeholder cached with `max-age` |
| `?purge=1` returns the same tile | purge skipped the read but never deleted the row |
| Cache never hits for one zoom level | `z` validated with `isFinite` instead of `isInteger` |
| Your assault notice never appears | events read from a global tail instead of per-pilot |
| Stream never closes / leaks | no `abort` listener, no `clearInterval` on the heartbeat |
| Theme flashes on reload | theme applied in an effect instead of the pre-mount `THEME_BOOT` script |
| Tailwind can't build the theme | per-theme utilities at build time; use CSS variables + `@theme inline` |
| `next build` fails on a missing env | `POSTGRES_URL` must exist, even unreachable |
| `npm install` destroys the lockfile | re-generate it once and commit; never let a routine install rewrite versions |
| `drizzle-kit generate --out=…` fails | use plain `drizzle-kit generate` |

---

## 16. Known gaps in the reference implementation

Do **not** reproduce these. They are documented in `README.md` §10 and `REVIEW_1.1.md` §3; the point of this
section is that a from-scratch build should close them rather than inherit them.

- `PATCH /api/config` is unauthenticated, as is `GET /api/terrain?debug=1`. Anyone can rewrite the world's balance.
- The pilot id in `localStorage` is a bearer token with no rotation or revocation.
- `action: "jump"` is declared in the claims body union but has no `case` in the switch — it returns 400. Either
  implement it or remove it from the type.
- `adopt` is accepted by `POST /api/player` and never used.
- Claim overlap is checked only against *your own* parcels (`< 0.002°`), not against other pilots'. Two pilots can
  hold overlapping ground.
- `listClaims` applies `ids`/`ownerIds` filters in JavaScript *after* `LIMIT 96`, so it silently misses rows at scale.
- Economy prices live in route handlers (relock is a hardcoded 900) instead of `world_config`.
- `/api/stream` polls Postgres every 3 s per connected pilot. Fine for a few dozen pilots; `LISTEN/NOTIFY` or a
  shared cursor poller is the upgrade before it is public.
- The raster is a visual drape, not the simulation surface. There is no hillshade, so slope legibility comes from
  silhouette and hue alone.

---

## 17. Definition of done

The build is complete when a new user can, without reading any documentation:

1. Open `/`, understand the premise from the landing page, and enter the world.
2. Register a pilot and be dropped at a real coordinate.
3. Pan the map, see real relief, and toggle FLAT / STACK / RASTER.
4. Survey and lock a 1 km parcel, seeing its elevation, soil, canopy and sprawl read-out before committing.
5. Build dwellings, fields, a fab and something enormous on the 48×48 grid, and see the economy respond —
   including being told *why* income is negative.
6. Walk the result in first person, over ground that rises and falls.
7. Switch between all five themes without a reload and without a flash.
8. Watch a parcel's lock count down, then take a foreign parcel by assault and read the after-action report.
9. Receive a notification about their own parcel within seconds, not on the next poll.

---

## Appendix — condensed prompt

For a model with a small context window, the following preserves the architecture while dropping the tables and
traps. It will produce a recognisably similar application, not an identical one.

> Build **Simplayz**: a persistent browser world simulator in Next.js 16 (App Router), TypeScript strict, React 19,
> Tailwind 4, three.js, zustand, Drizzle ORM + PostgreSQL.
>
> A seeded procedural terrain engine (`src/engine/terrain.ts`) generates relief, drainage, soil, canopy and urban
> sprawl from one integer seed using value noise and fBm. `heightAtM` works in Web Mercator metres, is shaped by a
> domain warp, an asymmetric base field, ridged orogeny, fluvial carving along a river-line field and lacustrine
> hollows, then classifies into 14 biomes by a fixed rule cascade. `surveyParcel` samples a 48×48 grid over a
> 1000 m parcel and freezes elevation, slope, water, forest, farm, build, defence and hydro scores into Postgres.
>
> The renderer is a single imperative three.js class drawing 3×3 tiles at zoom 15, 26 segments each. Terrain is
> **unlit** `MeshBasicMaterial` with vertex colours from a flat three-ramp palette — sea/lake blue, sand grey, land
> green — because colour is data, not light. Vertices still carry true elevation times `reliefScale` (1.35), with
> water pinned flat to `y = 0` and one translucent water plane behind the shoreline. A single `localGround()` is the
> only ground-height function for terrain, structures, parcels, the avatar, the camera and picking.
>
> Real OpenStreetMap raster is stacked **over** the flat base: a textured plane per tile at 55% opacity, fetched
> through an internal `/api/tiles/:z/:x/:y` cache, with FLAT / STACK / RASTER modes. That streamer caches PNGs in
> Postgres, reports provenance in `x-simplayz-*` headers, serves stale tiles on upstream failure, and falls back to
> a hand-built placeholder PNG — marked `no-store`, never cacheable.
>
> Players register a pilot, lock a 1000 m parcel for 72 hours, and place any of 18 structures on the 48×48 grid. A
> shared catalogue drives the palette, the meshes and the server validator. `computeTotals` derives income, upkeep,
> food, power, defence and prestige from the parcel's terrain scores; `applyTicks` accrues net income lazily per
> claim with a 48-tick cap. After the lock expires, `resolveAssault` settles a four-phase deterministic battle.
>
> Five glass themes (cartographer, violet, lilac, custom, chaos) apply at runtime through CSS custom properties
> re-exposed via Tailwind `@theme inline`, with an inline pre-mount script preventing a flash on reload.
>
> `/api/stream` is a Server-Sent Events channel scoped per pilot, additive to a 25 s polling fallback.
>
> Build in order: geodesy and terrain (verify determinism and relief ranges with a script first), then catalogue
> and simulation, then routes, then tile streamer, then renderer, then HUD, then themes, then notifications.
