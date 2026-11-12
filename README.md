# Simplayz

A persistent, browser-based sector simulation. Pilots stream real OpenStreetMap raster at zoom 15, but the
surface is re-invented by a seeded procedural terrain engine: relief, drainage, soil, canopy and legacy urban
sprawl are synthesised, quantised into a gameplay grid, stored in Postgres, and rendered in a three.js viewer.
Players lock 1 km² parcels around real coordinates, build on a 48×48 grid, accrue credits on an economy tick,
and assault each other's parcels after the seal expires.

Everything that can be tuned is a row in `world_config`. Nothing about the balance lives in a file.

- **Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) · Tailwind CSS 4 · three.js · zustand · Drizzle ORM · PostgreSQL
- **Source size:** ~5.3k lines across 24 TypeScript files
- **Working with an AI agent?** Read [`AGENT_BRIEF.md`](./AGENT_BRIEF.md) — it contains copy-paste prompts.

---

## 1. What it is

Simplayz is one app with three layers that must agree:

1. **A terrain engine** (`src/engine/`) — pure functions of `(longitude, latitude, seed)`. The same functions run in
   the browser (to build the mesh and score placements optimistically) and on the server (to author the
   authoritative survey). Same seed → same planet, on both tiers, with no synchronisation.
2. **A world ledger** (Postgres via Drizzle) — players, claims ("parcels"), buildings, cached surveys, cached map
   tiles, and an event feed. `world_config` is a single row that retunes the simulation live.
3. **A sector viewer** (`/world`) — a three.js scene with four camera modes (bird, build, first-person, third-person)
   wrapped in a HUD made of React panels.

The core loop:

> register a pilot → fly to coordinates → survey the ground → lock a parcel (sealed for `lockHours`) → raise
> structures on the grid → earn credits every `tickMinutes` → after the seal breaks, defend or assault.

---

## 2. Quick start

### Prerequisites

- **Node.js ≥ 20.9** (Next.js 16 requirement; developed on Node 22)
- **PostgreSQL** (uses `bytea`, `jsonb`, `timestamptz`)

### Setup

```bash
npm install

# 1. Database URL. Next.js reads .env / .env.local at runtime;
#    drizzle-kit reads .env only (it imports dotenv/config).
echo 'POSTGRES_URL=postgres://user:pass@localhost:5432/simplayz' > .env

# 2. Create the tables (schema is the source of truth)
npx drizzle-kit push          # fast path for dev
# or: npx drizzle-kit generate && npx drizzle-kit migrate   (writes SQL into ./drizzle)

# 3. Run
npm run dev                   # http://localhost:3000  (world at /world)
```

Both `.env` and `.env.local` are gitignored. `POSTGRES_URL` is read in exactly two places: `src/db/index.ts`
(runtime pool) and `drizzle.config.ts` (drizzle-kit).

### Scripts

| Script | Command | Notes |
| --- | --- | --- |
| `npm run dev` | `next dev` | Turbopack |
| `npm run build` | `next build` | **Fails if `POSTGRES_URL` is unset** — the variable must exist, the database does not have to be reachable |
| `npm run start` | `next start` | Production server |
| `npm run lint` | `eslint .` | Currently reports 4 errors / 2 warnings — see §9 |
| `npm run typecheck` | `tsc --noEmit` | Must stay clean |

### It degrades without a database

Every read path is wrapped in `try/catch` with a sensible fallback, so the app boots with a dead DB:

| Path | With an unreachable DB |
| --- | --- |
| `/` | 200, renders `DEFAULT_CONFIG` and zeroed counters |
| `/api/world` | 200, empty snapshot (config defaults, no claims) |
| `/api/config` | 200, defaults |
| `/api/terrain?lng=…&lat=…` | 200, computes the survey in-process (~90 ms) |
| `/api/tiles/{z}/{x}/{y}` | 200, hand-assembled placeholder PNG + `x-simplayz-tile-source: generated` |
| `/api/health` | 500 `{ ok: false }` (the one intentional failure) |

This is a deliberate invariant: **a database outage must never 500 a page.** New code should preserve it.

---

## 3. Architecture

```
┌─ browser ─────────────────────────────┐      ┌─ server (Next.js route handlers) ────────────┐
│ /world  (client page)                 │      │                                              │
│  ├─ viewport.tsx   three.js scene     │ fetch│  /api/world   /api/claims   /api/buildings   │
│  ├─ panels.tsx     HUD + modals       │ ────►│  /api/terrain /api/tiles    /api/config      │
│  └─ store.ts       zustand + actions  │  hdr │  /api/player  /api/health                    │
│       └ localStorage: pilot id        │  pilot│        │                                    │
└───────────────────────────────────────┘      │        ▼                                    │
              ▲                                │  lib/server.ts   DTO mapping, economy, auth   │
              │                                │     │                    │                    │
              │                                │     ▼                    ▼                    │
              │  the same pure modules          │  engine/*  (pure)     db/*  (Drizzle→Pg)     │
              └────────────────────────────────┼──────────────────────────────────────────────┘
                                               │  tile streamer ──► upstream raster (OSM)      │
                                               └──────────────────────────────────────────────┘
```

### Invariants worth knowing before you change anything

- **The engine is pure and isomorphic.** `src/engine/**` imports nothing from React, the DOM, `@/db`, or
  `@/lib/server`. It is imported by both the server routes and the browser bundle. No `Date.now()`, no
  `Math.random()` — randomness comes from `hashSeed()`.
- **Determinism is the product.** A survey is reproducible from `(lng, lat, sizeM, cells, seed)`. If you change
  the terrain algorithm, previously cached surveys become stale (see §8, recipe E).
- **DTOs are the boundary.** DB rows are snake_case; the client only ever sees camelCase DTOs declared in
  `src/lib/types.ts` and mapped in `src/lib/server.ts`.
- **Config, not literals.** Gameplay numbers belong in `world_config`; see the knob table in §6. (Some prices are
  still hardcoded in route handlers — see §10.)
- **Client never invents state.** Components read from the zustand store; mutations go through store actions that
  call `api()`, which injects the `x-simplayz-pilot` header. After a mutation, the store calls `refresh()`
  (`GET /api/world`), which re-reads everything.

### Request lifecycle (write path)

```
UI click → store action (store.ts) → fetch /api/<route> with x-simplayz-pilot
        → route handler: pilotFrom(req) → loadConfig() → ensurePilot()
        → validate → mutate via db / engine → logEvent()
        → Response.json({ ok: true, … DTOs })
        → store applies returned DTO → refresh() → new WorldSnapshot
```

### Auth model

No passwords, no sessions. `POST /api/player` mints a UUID which the client stores in
`localStorage["simplayz.pilot"]` and sends as `x-simplayz-pilot` (`/^[a-zA-Z0-9-]{6,64}$/`). That id is a bearer
credential for the ledger. If the header is absent, most routes answer `401`.

---

## 4. Repo map

Read this table instead of scanning the tree. ~line counts are rough and only indicate where the weight is.

| Path | What lives there |
| --- | --- |
| `src/app/layout.tsx` | Root HTML, metadata, `theme-color`, font/theme wiring |
| `src/app/globals.css` | Tailwind v4 `@theme` tokens, `@utility` classes, `.btn`/`.chip`, keyframes |
| `src/app/page.tsx` | `/` landing page (server component; reads config + row counts from DB) |
| `src/app/world/page.tsx` | `/world` shell: mounts the viewport and lays out HUD panels and modals |
| `src/app/world/store.ts` | zustand store (~330): all client state, `api()` fetch helper, every action |
| `src/app/world/panels.tsx` | Every HUD component and modal (~980): TopBar, PilotConsole, BuildPalette, ParcelInspector, Minimap, EventTicker, Toasts, OnboardModal, ConfigModal, IntelModal, HelpModal, AssaultReport, AdvisorAgent, plus `Modal`, `Bar`, `useTick` |
| `src/app/world/viewport.tsx` | three.js engine (~1220): `SimplayzEngine` class, scene/tile/claim/building mesh building, picking, 4 camera modes, React wrapper |
| `src/app/api/*/route.ts` | REST handlers (see §5). Reference patterns: `buildings` (multi-action POST), `terrain` (GET with query modes), `tiles/[z]/[x]/[y]` (dynamic params) |
| `src/lib/server.ts` | Server data layer (~530): pilot lifecycle, config load/save, claim listing + DTO mapping, survey cache, economy ticks, events, leaderboard, snapshot |
| `src/lib/types.ts` | All DTO contracts (`WorldConfigDTO`, `PlayerDTO`, `ClaimDTO`, `BuildingDTO`, `EventDTO`, `LeaderRow`, `WorldSnapshot`, …) |
| `src/db/schema.ts` | Drizzle table definitions + inferred row types (single source of truth for the schema) |
| `src/db/index.ts` | pg `Pool` + Drizzle client, dev-time global caching, throws if `POSTGRES_URL` missing |
| `src/engine/geo.ts` | Web Mercator math, tile math, `SectorFrame` planar helper, coordinate formatting |
| `src/engine/terrain.ts` | Noise, height field, climate/forest/urban signals, `classify()`, 14 biomes, `surveyParcel()`, `quickSample()`, `hashSeed()` |
| `src/engine/buildings.ts` | `BuildKind` interface + 18-entry `BUILD_KINDS` catalogue, rotation/footprint/height/cost helpers |
| `src/engine/simulation.ts` | Placement validation, occupancy, road service, `computeTotals()` economy, `resolveAssault()` combat, `lockCountdown()` |
| `drizzle.config.ts` | drizzle-kit config (schema path, Postgres dialect, `POSTGRES_URL`) |
| `next.config.ts` | Empty Next config (the place for headers, redirects, image domains) |
| `eslint.config.mjs` | Flat config; `next/core-web-vitals` + generated-folder ignores |
| `postcss.config.mjs` | `@tailwindcss/postcss` |

No `public/` directory exists yet (the landing page references `/images/sector-hero.jpg`, which 404s harmlessly).

---

## 5. HTTP API

All JSON responses use the envelope `{ ok: boolean, error?: string, ...payload }` **except** `GET /api/world`
(returns a bare `WorldSnapshot`), `GET /api/tiles/...` (returns `image/png`), and `GET /api/health` (`{ ok }`).
Status codes in use: `400` bad input/unknown action, `401` no registered pilot, `403` not the parcel owner,
`404` missing row, `409` rule violation (sealed parcel, occupied cell, insufficient credits), `500` unexpected.
Every handler exports `const dynamic = "force-dynamic"`.

| Method | Route | Input | Returns |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok }`; 500 if the DB ping fails |
| GET | `/api/config` | — | `{ ok, config: WorldConfigDTO }` |
| PATCH | `/api/config` | partial `WorldConfigDTO` | `{ ok, config }` — only keys present in `DEFAULT_CONFIG`, numbers rounded to 3 dp. **No auth.** |
| GET | `/api/player` | header | `{ ok, pilotId, player }` |
| POST | `/api/player` | `{ handle?, homeLng?, homeLat?, color?, adopt? }` | Registers a pilot when no header is sent (mints UUID + colored handle), otherwise updates. `adopt` is accepted but unused. |
| GET | `/api/world` | header | `WorldSnapshot`: `config, player, claims, events, leaderboard, stats, serverTime, engine` |
| GET | `/api/terrain` | `?lng&lat` / `?claim=<id>` / `?debug=1` | Survey at a point (cached per `terrainCacheSeconds`), stored claim survey, or engine telemetry |
| GET | `/api/tiles/[z]/[x]/[y]` | `?purge=1` | PNG from Postgres cache → upstream → stale cache → generated placeholder. Headers: `x-simplayz-tile-source`, `-key`, `-hits`, `-overlay` (`raw` or `player-authored:<n>parcel/<n>structures`) |
| POST | `/api/claims` | `{ action: "claim" \| "abandon" \| "rename" \| "relock" \| "assault", … }` | `claim` needs `lng`,`lat`,`name`; `rename` needs `name`; the rest need `claimId`. `"jump"` is declared in the type but not implemented (→ 400). |
| POST | `/api/buildings` | `{ action: "place" \| "demolish" \| "upgrade" \| "repair", claimId, … }` | `place` needs `kind`,`cellX`,`cellY`,`rot`; `demolish`/`upgrade` need `buildingId`; `repair` heals the whole parcel |

Multi-operation routes switch on an `action` string in the POST body. Follow that shape for new operations on an
existing resource; create a new route for a new resource.

---

## 6. Tunable world config

Row `world_config.id = 1`, all columns `NOT NULL` with defaults. `PATCH /api/config` writes any subset.

| DTO key | Column | Default | What it changes |
| --- | --- | --- | --- |
| `claimSizeM` | `claim_size_m` | `1000` | Parcel edge in metres; cell size = `claimSizeM / gridCells` |
| `gridCells` | `grid_cells` | `48` | Survey cells per axis and the build grid |
| `lockHours` | `lock_hours` | `72` | Seal window before a parcel can be assaulted |
| `maxClaims` | `max_claims` | `3` | Parcels per pilot |
| `tileZoom` | `tile_zoom` | `15` | Raster zoom; also how a claim is pinned to a tile |
| `tileSource` | `tile_source` | `https://tile.openstreetmap.org` | Upstream raster for the streamer |
| `tileTtlHours` | `tile_ttl_hours` | `36` | Tile cache lifetime |
| `terrainCacheSeconds` | `terrain_cache_seconds` | `600` | How long a spot survey stays cached |
| `terrainSeed` | `terrain_seed` | `20770418` | The planet. Changing it re-hallucinates every mesh |
| `reliefScale` | `relief_scale` | `1.35` | Vertical exaggeration of the rendered mesh |
| `tickMinutes` | `tick_minutes` | `5` | Economy heartbeat |
| `startCredits` | `start_credits` | `9000` | Credits minted at registration |
| `assaultEnabled` | `assault_enabled` | `true` | Global PvP switch |

⚠️ These defaults exist in **four** places today: `src/db/schema.ts`, `DEFAULT_CONFIG` (`src/lib/server.ts`),
`FALLBACK_CONFIG` (`src/app/world/store.ts`) and the mapping in `src/app/page.tsx`. Adding a knob means touching
all four — recipe F in §8 lists them in order.

---

## 7. Simulation rules (the numbers)

Canonical sources: `src/engine/simulation.ts` and `src/engine/buildings.ts`. If this prose disagrees with the code,
the code wins.

**Survey.** `surveyParcel()` samples `gridCells²` cells, row-major (`index = y * cells + x`), and returns
`{ y: quantised metres, b: biome index, ok: 0 | 1 | 2 }` plus a `profile` (elevation, slope, water/forest/urban
fractions, farm/build/defense scores, biomass, minerals, hydro, biome histogram).

**Placement** (`checkPlacement`). Footprint must stay inside the grid and not overlap an occupied cell;
any `ok === 0` cell refuses construction; any `ok === 2` cell (slope > 20°) multiplies cost by **1.6**; the worst
biome `costMod` under the footprint applies; `minFarm` gates food structures; credits must cover the cost.

**Economy** (`computeTotals`), per structure and tick:

```
scale      = 1 + 0.55 × (level − 1)
integrity  = clamp(integrity / 100, 0.15, 1)
served     = needsRoad ? hasRoadAccess(...) : true        // unserved → ×0.35
eff        = (served ? 1 : 0.35) × scale × integrity
income    += kind.income × eff × connectivity × (food ? soil : 1)
upkeep    += kind.upkeep × scale
population+= kind.population × eff × (served ? 1 : 0.6)
defense   += kind.defense × scale × biomeCover × integrity
connectivity = 1 + min(0.35, junctions × 0.07)
netIncome  = max(−60, round(income − upkeep))
defense    = round((defense × 10 + 40) × (0.75 + terrainDefense × 0.22))
```

**Ticks.** `applyTicks()` runs lazily inside `snapshot()` for the requesting pilot: every `tickMinutes` elapsed
since `claims.last_tick_at`, credits grow by `netIncome × min(ticks, 48)`.

**Assaults** (`resolveAssault`, deterministic from a seed, four phases RECON → BREACH → HOLD → FLAG):

```
mobilisation = min(0.85, max(0.12, credits / 9000))
momentum     = 1 + min(0.6, reputation / 420)
attack       = 60 + mobilisation × 240 × momentum + recon × 70
defend       = defenseScore × (0.85 + breach × 0.4) × (0.8 + terrainDefense × 0.25) + 30
margin       = attack − defend + hold × 0.35 + flag × 0.15      // success if margin > 0
```

A win transfers ownership, resets the seal, pays loot and reputation, and writes a `world_events` row; the loser
takes a loss and −8 reputation.

**Other prices** currently hardcoded in `src/app/api/buildings/route.ts` / `claims/route.ts`: relock **900 cr**,
repair **400 cr**, upgrade max tier **5**, upgrade cost `round(cost × 0.7 × 1.55^level)`, demolition refund
**35 % × cost × level**, assault reputation swing as coded in `resolveAssault`.

---

## 8. UI/UX system

### Design tokens (`src/app/globals.css`, Tailwind v4 `@theme`)

| Token | Value | Use |
| --- | --- | --- |
| `void` | `#04070a` | page background |
| `hull` | `#090f14` | alternate section background |
| `panel` | `#0c141b` | panel base (see utility) |
| `line` | `#1b2b36` | borders, hairlines |
| `mint` | `#7df0c0` | primary accent / positive |
| `amber` | `#ffb454` | hot actions, warnings |
| `ice` | `#68b7ff` | informational |
| `rose` | `#f47ba8` | negative |

Utilities: `panel` (glass background + border + inset highlight), `label` (10 px uppercase tracked caption),
`hairline` (fading divider), `grid-bg` (blueprint grid), `scan` (CRT scanlines).
Component classes: `.btn`, `.btn-on` (selected), `.btn-hot` (primary/amber), `.chip`.
Animations: `anim-sweep`, `anim-blink`, `anim-rise`, `anim-ticker`.
Inputs (`text`, `number`, `select`, `textarea`, `range`) are styled globally — use them, don't restyle per form.

Rule of thumb: use tokens (`text-mint`, `border-line`, `bg-void/70`) and the utilities above. Literal hex values in
TSX are reserved for data-driven colors that come from the engine catalogues (`biome.color`, `kind.color`,
`player.color`).

### HUD inventory (`src/app/world/panels.tsx`)

| Component | Purpose |
| --- | --- |
| `TopBar` | Brand, mode switch (BIRD / BUILD / TOUR·FPS / TOUR·TPS), clock, FPS/draws/tris, day-night slider, tile toggle, panel buttons |
| `PilotConsole` | Pilot registration/GPS hook, survey + claim form, parcel list, rapid controls |
| `BuildPalette` | Category filter, 18 structure cards, tool switch (raise / salvage / inspect), rotation, stat readout |
| `ParcelInspector` | Selected parcel: owner, totals from `computeTotals`, structure list, upgrade/demolish/relock/abandon |
| `AdvisorAgent` | Deterministic rule stack ("site agent") that suggests the next build with one-click selection |
| `Minimap` | Canvas top-down biome render + claim rectangles + click-to-fly |
| `EventTicker` | Scrolling `world_events` feed |
| `Toasts` | Transient notifications (4 max, 5.2 s) |
| `OnboardModal` / `ConfigModal` / `IntelModal` / `HelpModal` | Registration, live `world_config` editor, leaderboard/telemetry, controls reference |
| `AssaultReport` | Phase-by-phase combat report from the last assault |

Shared primitives in the same file: `Modal` (centered overlay, `wide` variant), `Bar` (labelled meter), `useTick`
(ticking clock). Panels that need clicks must set `pointer-events-auto` — the HUD overlay itself is
`pointer-events-none`.

### The 3D viewer (`src/app/world/viewport.tsx`)

- `SimplayzEngine` is a plain imperative class (no React inside). The React wrapper `WorldViewport` instantiates it
  once, forwards store state through `engine.update(view)`, and exposes `focus()`, `teleportLocal()`, `dispose()`.
- `update()` diffs with two keys: `sectorKey` (seed + relief → rebuild terrain) and `claimsKey`
  (config + per-claim building counts/status/owner → rebuild claims). **If you add scene data, extend those keys**
  or the scene will silently not rebuild.
- `EngineCallbacks`: `onHover`, `onPlace`, `onPickBuilding`, `onPickClaim`, `onTelemetry`, `onLeaveTour`.
- The engine instance is also published on `window.__simplayz`; HUD helpers `engineFocus()` / `engineTeleport()` use
  it.
- Surveys are recomputed client-side with the same pure `surveyParcel()` and memoised in a module-level
  `surveyCache` keyed by `claimId:seed:sizeM:cells`.

### Controls

Bird/build: drag LMB pan, drag RMB (or Shift+drag) orbit, wheel dolly, Q/E slow orbit, R rotate the footprint,
click a cell to place. Tour: click the world to capture the pointer, WASD move, Shift sprint, Space hop,
Esc release.

---

## 9. Conventions & guardrails

1. **Imports** use the `@/*` alias (`@/engine/…`, `@/lib/…`). Don't cross layers with `../../`.
2. **Keep `src/engine/**` pure.** No React, DOM, Drizzle, or `@/lib/server` imports; no `Date.now()`,
   no `Math.random()` (use `hashSeed`). It is bundled for the browser *and* executed on the server.
3. **Server work goes through a route handler → `src/lib/server.ts` helper.** Shared reads/mappers and multi-step
   mutations live in `lib/server.ts`; action-specific single writes may use `db` directly in the route (see
   `buildings`). Wrap DB calls so a outage degrades instead of throwing.
4. **Map rows → DTOs on the server.** Declare the shape in `src/lib/types.ts`, produce it in `lib/server.ts`.
   Never send a raw row (snake_case) to the client.
5. **API shape:** `{ ok, error?, … }`, explicit status codes, `action` strings for multi-operation POSTs,
   `export const dynamic = "force-dynamic"`.
6. **Client data only through the store.** Components call store actions; actions use the `api()` helper (which
   adds the pilot header) and then `refresh()`. No `fetch` inside components.
7. **Styling** uses tokens and shared utilities (§8). A genuinely new color belongs in `@theme`, not in JSX.
8. **The viewer rebuilds by key.** New scene-affecting fields must be added to `claimsKey`/`sectorKey`.
   GPU resources created by the engine must be released in `dispose()`.
9. **Comments:** the codebase uses banner comments (`/* ---- section ---- */`) and explains *why*, not *what*.
   Match that style.
10. **Next.js 16 details:** route `params` is a `Promise` (`await ctx.params` — copy the tiles route); client
    components start with `"use client"`; `WorldViewport` is loaded with `dynamic(..., { ssr: false })`.
11. **Schema is the source of truth.** Change `src/db/schema.ts`, then `drizzle-kit generate` (commit the SQL in
    `./drizzle`) or `push` for local work. Don't hand-edit production tables.
12. **Terrain changes invalidate caches.** Existing `terrain_regions` rows are keyed by seed/size/cells, not by
    algorithm version. After changing the terrain maths, either bump `terrainSeed` or truncate
    `terrain_regions` — otherwise old parcels render the old land.

### Definition of done for any change

```bash
npm run typecheck                                   # clean
npm run lint                                        # no NEW problems (baseline below)
POSTGRES_URL=postgres://x:y@127.0.0.1:5432/x npm run build
npm run dev                                         # smoke-test the touched route/page
```

Baseline lint state (pre-existing; don't chase these unless the task is to fix them):

| File | Line | Rule | Note |
| --- | --- | --- | --- |
| `src/app/world/panels.tsx` | 126 | `react-hooks/set-state-in-effect` | hover → coordinate sync |
| `src/app/world/panels.tsx` | 667 | `react-hooks/set-state-in-effect` | ConfigModal draft sync |
| `src/app/world/panels.tsx` | 793 | `react-hooks/rules-of-hooks` | `void useNoop()` left in |
| `src/app/world/viewport.tsx` | 1159 | `react-hooks/refs` | ref written during render |
| `src/app/page.tsx` | 67 | `@next/next/no-img-element` | warning |
| `src/app/world/panels.tsx` | 531 | `react-hooks/exhaustive-deps` | warning |

`npm run typecheck` and `next build` both pass today; `next build` **requires** `POSTGRES_URL` to be defined.

### How to extend — recipes

Every recipe below lists files in the order you should touch them. The linked task prompts live in
[`AGENT_BRIEF.md`](./AGENT_BRIEF.md).

**A. New UI/UX component (HUD panel or modal)**
1. `src/app/world/panels.tsx` — add and export the component; pull state with `useWorld((s) => …)`; reuse `Modal`,
   `Bar`, `useTick`, `.btn`, `.panel`, `.label`.
2. `src/app/world/page.tsx` — mount it in the HUD tree (`pointer-events-auto` for anything clickable).
3. If it opens as a modal: extend the `panel` union in `src/app/world/store.ts` and render it in `page.tsx`.
4. If it needs new state or mutations: add fields + an action to the store (use `api()`), don't fetch in the
   component.
5. If it needs server data that isn't in the snapshot: extend `WorldSnapshot` (`src/lib/types.ts`) and
   `snapshot()` (`src/lib/server.ts`).
6. New color/animation: `src/app/globals.css` (`@theme` / `@utility` / keyframes).

**B. New API endpoint**
1. `src/lib/types.ts` — request/response DTOs.
2. `src/lib/server.ts` — query/mapper helper with `try/catch` fallback.
3. `src/app/api/<name>/route.ts` — new handler: `dynamic = "force-dynamic"`, `pilotFrom` → `loadConfig` →
   `ensurePilot`, validate, `Response.json`, status codes. Copy `src/app/api/buildings/route.ts` (POST with
   actions) or `src/app/api/terrain/route.ts` (GET with query params).
4. `src/app/world/store.ts` — action that calls it via `api()` and updates state, then `refresh()`.
5. Add the row to the API table in §5.

**C. New table / column (model)**
1. `src/db/schema.ts` — table (snake_case columns) with `references(...)`; export `typeof x.$inferSelect`.
2. `npx drizzle-kit generate` (commit `./drizzle/*.sql`) or `npx drizzle-kit push` for local dev.
3. `src/lib/types.ts` — DTO.
4. `src/lib/server.ts` — row→DTO mapper + read/write helpers.
5. If the client reads it: add to `WorldSnapshot` and `snapshot()`; consume via `store.boot()` / `refresh()`.
6. If it is writable: route handler (recipe B).

**D. New build kind (structure)**
1. `src/engine/buildings.ts` — append to `BUILD_KINDS` (`key` unique, `category`, `footprint`, `roof` from
   `flat | pitch | dome | none | panels`, stats, `blurb`). `KIND_MAP`, `CATEGORY_LABEL`, the palette, the placement
   validator and the server all derive from this array — usually no other wiring is needed.
2. `src/engine/simulation.ts` — only if it needs new mechanics (`needsRoad`, `minFarm`, bespoke totals).
3. `src/app/world/viewport.tsx` — only if it needs a bespoke mesh (the generic factory handles category + roof
   styles; see the `beacon` beam block for a custom effect).
4. Save = it is instantly in the palette, the API validator, and the landing page catalogue.

**E. New biome**
1. `src/engine/terrain.ts` — append to `BIOMES`; **`id` must equal the array index** because `classify()` and
   `SurveyCell.b` use indices. Choose `buildable`, `fertility`, `cover`, `costMod`.
2. `classify()` — add/retune a branch to emit it.
3. Consumers pick it up automatically: survey stats, palette tooltips, minimap, landing page, placement cost/refusal.
4. Invalidate cached surveys (see guardrail 12).

**F. New `world_config` knob**
1. `src/db/schema.ts` — column + default.
2. `npx drizzle-kit generate` / `push`.
3. `src/lib/server.ts` — `DEFAULT_CONFIG`, `mapConfig()`, and (if numeric rounding matters) `saveConfig()` handles
   it automatically from `DEFAULT_CONFIG` keys.
4. `src/lib/types.ts` — `WorldConfigDTO`.
5. `src/app/world/store.ts` — `FALLBACK_CONFIG`.
6. `src/app/page.tsx` — the `config = { ...DEFAULT_CONFIG, … }` mapping (and optionally the ledger display).
7. `src/app/world/panels.tsx` — a field in `ConfigModal`.
8. `src/app/world/viewport.tsx` — if it changes the scene, add it to `sectorKey`/`claimsKey`.

**G. End-to-end feature (recommended order)**
`engine` (pure maths/catalogue) → `schema` (+ migration) → `lib/types` → `lib/server` → `api/route` →
`store` action/state → `panels` UI → `viewport` scene → docs (`README` tables) → smoke test.

---

## 10. Known gaps & rough edges

Current, verified state — useful as a task list rather than a wish list.

- **No auth on writes that aren't pilot-scoped.** `PATCH /api/config` and `GET /api/terrain?debug=1` are open.
  A pilot id in `localStorage` is a bearer token with no rotation or revocation.
- **`jump` is dead code.** Declared in `ClaimBody` but the switch has no case → 400.
- **`adopt`** is accepted by `POST /api/player` but never used.
- **Missing assets.** No `public/` directory; `/images/sector-hero.jpg` is referenced by the landing page and 404s.
- **Duplicated config defaults** in four places (§6) — the most likely source of drift in this repo.
- **Hardcoded economy prices** in route handlers (§7) rather than in `world_config`.
- **`listClaims` filters after `LIMIT 96`** in JS for `ids`/`ownerIds`, so it can miss rows at scale.
- **Claim overlap is only checked against your own parcels** (`< 0.002°`), not against other pilots'.
- **Tile streamer fetches OSM directly.** Fine for development; production should self-host or use a
  policy-compliant provider.
- **No tests, no CI.** Verification is manual (§9).
- **Lint baseline is red** (4 errors / 2 warnings, table in §9).
- **No `LICENSE` file** — add one before publishing.

---

## 11. Glossary

| Term | Meaning |
| --- | --- |
| **Pilot** | A player. Identified by a UUID stored in the browser; no password |
| **Parcel / claim** | A square of `claimSizeM` metres locked by a pilot; the unit of territory |
| **Survey** | The engine's quantised read-out of a parcel (grid + profile), cached in `terrain_regions` |
| **Sector** | The 3×3 tile window the viewer currently streams |
| **Seal / lock** | The `lockHours` window during which a parcel cannot be assaulted |
| **Tick** | The `tickMinutes` economy heartbeat that accrues credits |
| **Tour** | First/third-person walking mode over the same scene |
| **Streamer** | The internal `/api/tiles` proxy that caches upstream raster and reports overlay state |
| **Prestige** | Score from structures; scales loot and defense in assaults |
| **Integrity** | Structure health (0–100) multiplying its economic output |

---

## 12. Working with AI agents

`AGENT_BRIEF.md` holds copy-paste prompts. The short version:

> Work in this repo following `README.md` — read §4 (repo map), §9 (conventions) and the matching recipe in §9
> before opening any file. Do not scan unrelated files. Task: **&lt;your task&gt;**. Acceptance: **&lt;checks&gt;**.
> Run typecheck, lint and build per §9 when done.

Point an agent at this README instead of letting it walk the tree; the recipes exist precisely so a new chat can
start at the right file. If this document and the code disagree, the code is right — fix the README in the same PR.
