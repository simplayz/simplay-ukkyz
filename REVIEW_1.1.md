# Simplayz 1.1.0 — code review & enhancement plan

Reviewed against the product statement:

> **Simplayz world simulator** streams real OpenStreetMap raster at zoom 15, then re-hallucinates the surface: relief, drainage, soil, canopy and legacy sprawl are synthesised from a seeded field model, stored in Postgres and handed to a three.js sector viewer. Lock 1000 m of ground around your own coordinates, raise dwellings, fields, fabs and megastructures on a 48×48 grid, then walk what you built in first or third person. Nobody can touch your parcel for 72 hours. After that, it is target practice.

Verdict up front: **the simulator half of that sentence is real and unusually complete. The multiplayer half is not built yet.** Almost every gap below comes from that split.

---

## 1. What 1.1.0 changed

`/api/tiles` was previously orphaned — a working, DB-cached OSM proxy with provenance headers that the renderer never called. It is now the top layer of the map again, without giving up the flat cartography from 1.0.0:

| Layer | Contents | Where |
| --- | --- | --- |
| Base | seeded flat palette — sea/lake bands, sand, graded land, hillshade | `buildOneTile()` → 26×26 `PlaneGeometry`, vertex colours |
| Stacked | live OSM raster at 55% under a `polygonOffset` drape | `buildTileOverlay()` → textured plane at `y = 2.5` |
| Above | claims, buildings, avatar, grid, sky | unchanged |

Three modes on the top bar: **FLAT** (no network at all), **STACK** (default), **RASTER** (full-strength imagery). The raster is fetched through `/api/tiles/{z}/{x}/{y}` — never directly from OSM — so the streamer keeps its `x-simplayz-tile-source` (`cache`/`origin`/`stale`/`generated`) and `x-simplayz-overlay` (`raw` / `player-authored:…`) headers, and both are surfaced in the telemetry strip. `tileSource` in the HUD now reads `streamer` once a real tile lands instead of the old hardcoded `flat-engine`.

Four defects fixed along the way:

1. **Placeholder tiles were CDN-cacheable for 36 h.** The `generated` fallback PNG was served with `max-age=129600`. One flaky upstream fetch could poison a CDN edge with a blank tile for a day and a half. `respond()` now forces `no-store` for that source.
2. **`?purge=1` did not purge.** It skipped the cache *read* but never deleted the row, so the very next request served the stale tile again. It now issues the delete.
3. **Fractional zoom built invalid cache keys.** `z = 15.5` passed the `Number.isFinite` guard and produced a `15.5/x/y` row that could never be hit again. The guard is now `Number.isInteger`.
4. **Overlay lifecycle leaks.** In-flight tile fetches are aborted on sector rebuild, bitmaps that resolve after their sector was torn down are explicitly `.close()`d, and `emitTelemetry()` is a no-op after `dispose()`. Switching FLAT → STACK after panning now backfills only the tiles that are actually missing an overlay, rather than testing "are there any overlays".

---

## 2. Where the code meets the statement

**Genuinely done.**

- **Seeded field model, five surface layers.** `src/engine/terrain.ts` derives relief (`heightAtM`), drainage (`riverMaskM`), soil fertility, canopy/forest cover and a legacy-sprawl urban mask from `vnoise`/`fbm` on `terrainSeed`. Same seed, same world — hermetic, no external elevation API.
- **Postgres as the system of record.** Drizzle schema covers players, claims, buildings, terrain regions, world events, world config and `tile_cache`. `surveyParcel()` results are persisted, not recomputed per view.
- **48×48 grid, 1000 m parcels, 72 h locks.** `claimSizeM: 1000`, `gridCells: 48` (≈20.8 m cells), `lockHours: 72`, and `lockCountdown()` genuinely gates the assault path server-side in `/api/claims` — the client cannot bypass it.
- **The build catalogue reads like the pitch.** 18 kinds including Pod Dwelling, Field Strip, Fab Line, Megastructure Mall, Photon Field, Hydro Vault, Watch Spire, Blast Berm.
- **First *and* third person.** `Mode = "bird" | "build" | "fps" | "tps"` with pointer lock, terrain-following walk speed modulated by biome walkability, and a chase camera.
- **The tile streamer is a real cache**, not a passthrough: 4000-tile cap with 500-row FIFO prune, TTL, hit counting, stale-serving on upstream failure, and a dependency-free hand-built PNG fallback so a cold offline start still renders.

---

## 3. Where it does not

**3.1 The economy exists, but it is invisible and undefended in depth.**
Correction to an earlier draft of this review: the tick is real. `applyTicks()` (`src/lib/server.ts:326`) accrues `totals.netIncome` lazily per claim — `floor((now - lastTickAt) / tickMinutes)`, capped at 48 ticks so an abandoned parcel cannot farm a year of income on return, and `greatest(0, credits + delta)` so debt is clamped. That is the right design: no cron, no global lock, no double-credit on concurrent reads.

What is missing is the *feedback* and the *stakes*. Income is a number in the ledger; nothing in the world shows a Fab Line earning. There is no upkeep pressure, no decay, no structure that costs more than it makes in a bad position. So the 72-hour lock protects a passive balance rather than an operation. The assault model (`resolveAssault()`) reads defence, berms and spire detection properly, but the player is never given a reason to look at either number until someone attacks. This is a *presentation and balance* gap, not a missing subsystem.

**3.2 Nobody can see anybody, and the victim learns last.**
`/world` polls `refresh()` every 25 s. No websocket, no SSE, no presence, no avatar replication. The server is correct — `/api/claims` validates the lock before an assault — but the *information* path is backwards: `recentEvents()` returns the newest 18 rows **globally**, unscoped by owner. So a busy world pushes your own assault notice off the list, and `snapshot()` gives you no per-claim event feed at all. The victim's only signal is a credit/ownership change noticed on the next poll, if they happen to be looking at that parcel.

Two cheap corrections before any realtime work: scope `recentEvents()` to the claims you own (plus public events), and add an "incoming" badge on the parcel that was hit.

**3.3 The minimap and the main view agree on colour, not on geometry.**
Both call `quickSample()` + `paintFlatColor()`, so hue never disagrees — the README's claim there is correct. But the *grids* are independent: `buildOneTile()` resamples per tile vertex in a sector frame snapped to Web-Mercator tile bounds, while `Minimap` samples a square around the camera centre with its own span. They can therefore disagree at the edges about *which cell is water*, even though a given cell would paint the same colour in both. Extracting one `sampleHeightGrid(frame, seed)` and letting both rasterise it removes the class of bug.

**3.4 The raster and the flat map are not registered to each other.**
Overlays assume `tileZoom` is 15 (`const key = \`15/${tx}/${ty}\``). Change `tileZoom` in the config panel and the flat grid rescales while the raster silently keeps requesting z15. Also, `SectorFrame.tileLocal()` respects Web-Mercator tile boundaries but the *flat* terrain sampler is evaluated in plain metres — at 1 km extent the Mercator-to-ground-scale error is sub-metre, so it is invisible today, but the assumption is undocumented. One-line fixes, both worth taking.

**3.5 No elevation on the base.** All flat vertices are `y = 0` and `localGround()` returns `0`. The seeded `heightAtM` field is fully implemented and *used for placement/pricing*, but the ground you look at is a colour gradient, not a surface. Relief exists in the model and stops at the renderer — which is exactly the "re-hallucinate the surface" claim not being delivered visually.

**3.6 Scale and identity are thin.** No parcel-to-parcel travel, no waypoint markers, no compass, no "who owns this" on hover except in inspect mode. `engineTeleport()` jumps by coordinate, not by claim.

---

## 4. Enhancement plan

Ordered by leverage against the statement, not by effort. Each is scoped to be independently shippable.

### Tier 1 — closes the gap between the pitch and the product

**E1. Make the tick legible.**
`applyTicks()` is already correct; do not rewrite it. Instead surface it: a credits delta floating on each producing structure when it ticks, a "accruing since HH:MM" line on the claim card, and a per-kind breakdown of `netIncome` in `computeTotals()`. Then add the *pressure* the current design lacks — `upkeep` proportional to footprint, so a parcel left idle while sealed bleeds credits. That is what converts a lock window into a decision: seal it and pay upkeep, or open it and risk an assault while it earns.

**E2. Live presence over SSE.**
`/api/stream` using `ReadableStream` — tail `worldEvents` by id cursor and push the new rows for claims you own. Postgres `LISTEN/NOTIFY` is the upgrade, not the starting point: a 3–5 s server-side poll inside the route handler is simpler and holds the stream open just as well. Push: assault incoming, lock expiring within an hour, another pilot entering your parcel, your own tick posting. Keep the existing 25 s `refresh()` as the resync fallback so a dropped stream degrades instead of freezing.

**E3. Give the ground its relief.**
Set `vertex.y = heightAtM(x, z, seed) * reliefScale * 0.06` on the 26×26 grid in `buildOneTile()`, keep `reliefScale` as the single knob, and tilt the overlay plane with the same field (subdivide it to match). `localGround()` then returns the real sampled height so buildings sit on the slope instead of a plane. The field model already exists — this is renderer-only work and it is the difference between "coloured map" and "terrain".

### Tier 2 — depth for players who stay

**E4. Claim-to-claim travel and a radar.** A `navigate(claimId)` that flies the camera along a spline and a radar showing nearby claims, their owners, lock state and distance. Reuses `lockCountdown()` for the ring colour.

**E5. Structure specialisation.** Each kind gets two upgrade paths (e.g. Fab Line → *Foundry* (yield) or *Assembly* (build speed); Watch Spire → *Sentry* (detection) or *Beacon* (claim radius)). Levels already exist in the schema and in `structureVisualHeight()`, and `computeTotals()` already reads `level` — the gap is that levelling is not exposed as a player action.

**E6. Assault readability.** `resolveAssault()` returns a numeric report; render it as an after-action diagram (which berm absorbed what, damage per structure). Players currently get a log line for the most dramatic event in the game.

**E7. A deterministic replay.** Because the tick and assault are both pure functions of `(state, seed)`, store the event log and let a player scrub their parcel's history. Nearly free given the current architecture, and a strong differentiator.

### Tier 3 — hygiene

**E8. One map sampler.** Extract `sampleHeightGrid(frame, seed)` from `buildOneTile()` and have `Minimap` consume the same grid. Colour is already shared; geometry is not.
**E9. Derive the overlay zoom from config** (`view.config.tileZoom`) instead of the literal `15`, and clamp to `0..19` consistent with the route guard.
**E10. Texture budget.** 9 overlays × 256 px is fine, but `dispose()` should also traverse `map`/`emissiveMap` on materials; today only the overlay planes do it explicitly. A `disposeMaterial()` helper prevents the next leak.
**E11. Wire `assaultEnabled` and `tickMinutes` into the HUD** — both are editable in config but unread by anything, which reads as a bug to anyone who opens the panel.

---

## 5. Suggested order

1. **E3** (relief) — highest visual return per line of code, unblocks E4/E6.
2. **E2** (SSE) — makes it multiplayer in the sense the pitch promises; today the only multiplayer signal is a 25 s poll.
3. **E1** (tick legibility + upkeep) — turns the lock window into a decision.
4. **E8/E9** — do these before the map gains more features, while the sampling grid is still duplicated.
5. Everything else.

The `/api/tiles` layer added in 1.1.0 is deliberately independent of all of the above: every enhancement in this list works with the flat base, the stacked raster, or both, because the base stays authoritative and the raster is a drape.
