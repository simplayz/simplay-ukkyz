import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { worldConfig } from "@/db/schema";
import { DEFAULT_CONFIG, ENGINE_IDENTITY } from "@/lib/server";
import { BUILD_KINDS } from "@/engine/buildings";
import { CARTO_PALETTE, classifyLand, swatches } from "@/engine/palette";
import { ThemeHost } from "./theme-host";

export const dynamic = "force-dynamic";

async function count(from: string) {
  try {
    const res = await db.execute(sql.raw(`select count(*)::int as n from ${from}`));
    const rows = (res as unknown as { rows?: { n: number }[] }).rows ?? [];
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export default async function HomePage() {
  let config = DEFAULT_CONFIG;
  try {
    const rows = await db.select().from(worldConfig).limit(1);
    if (rows[0]) {
      config = {
        ...DEFAULT_CONFIG,
        claimSizeM: rows[0].claimSizeM,
        gridCells: rows[0].gridCells,
        lockHours: rows[0].lockHours,
        maxClaims: rows[0].maxClaims,
        tileZoom: rows[0].tileZoom,
        tileSource: rows[0].tileSource,
        tileTtlHours: rows[0].tileTtlHours,
        terrainCacheSeconds: rows[0].terrainCacheSeconds,
        terrainSeed: rows[0].terrainSeed,
        reliefScale: rows[0].reliefScale,
        tickMinutes: rows[0].tickMinutes,
        startCredits: rows[0].startCredits,
        assaultEnabled: rows[0].assaultEnabled,
      };
    }
  } catch {
    config = DEFAULT_CONFIG;
  }

  const [nPlayers, nClaims, nBuildings, nTiles, nSurveys, owned] = await Promise.all([
    count("players"),
    count("claims"),
    count("buildings"),
    count("tile_cache"),
    count("terrain_regions"),
    count("claims"),
  ]);

  const stats: [string, number][] = [
    ["registered pilots", nPlayers],
    ["parcels locked", nClaims],
    ["structures raised", nBuildings],
    ["tiles in streamer", nTiles],
    ["surveys cached", nSurveys],
  ];

  const bands = swatches(CARTO_PALETTE);
  const legend: { key: string; label: string; from: string; to: string; note: string }[] = [
    { key: "water", label: "sea · lake · river", from: CARTO_PALETTE.water[0], to: CARTO_PALETTE.water[1], note: "blue gradient · deep → shallow" },
    { key: "sand", label: "beach · sandflat · marsh", from: CARTO_PALETTE.sand[0], to: CARTO_PALETTE.sand[1], note: "grey gradient · wet → dry" },
    { key: "land", label: "plains · forest · mountain", from: CARTO_PALETTE.land[0], to: CARTO_PALETTE.land[1], note: "green gradient · lowland → summit" },
  ];

  return (
    <ThemeHost>
    <div className="min-h-screen bg-void text-dim">
      <div className="relative overflow-hidden border-b border-line">
        <div className="absolute inset-0 theme-glow opacity-70" />
        <div className="absolute inset-0 grid-bg opacity-30" />
        <div className="absolute inset-0 bg-gradient-to-b from-void/40 via-void/65 to-void" />

        <header className="relative z-10 mx-auto flex max-w-6xl items-center gap-4 px-6 py-5">
          <div className="flex items-center gap-2.5">
            <div className="relative h-7 w-7 border border-mint/70">
              <div className="absolute inset-[4px] bg-mint" style={{ clipPath: "polygon(50% 0,100% 100%,0 100%)" }} />
            </div>
            <span className="text-[15px] font-semibold tracking-[0.42em] text-ink">SIMPLAYZ</span>
            <span className="chip px-1.5 py-0.5 text-[9px] tracking-[0.18em] text-mint">v1.0.0</span>
          </div>
          <nav className="ml-auto flex items-center gap-2 text-[11px]">
            <Link href="/world" className="btn px-3 py-2">ENTER SECTOR</Link>
            <a href="#engine" className="btn px-3 py-2">ENGINE</a>
            <a href="#rules" className="btn px-3 py-2">RULES</a>
          </nav>
        </header>

        <div className="relative z-10 mx-auto grid max-w-6xl gap-10 px-6 pb-16 pt-10 lg:grid-cols-[1.25fr_1fr]">
          <div>
            <div className="label mb-4 flex items-center gap-2">
              <span className="h-1.5 w-1.5 anim-blink rounded-full bg-mint" />
              {ENGINE_IDENTITY.name} · v1.0.0 · live
            </div>
            <h1 className="text-[clamp(2.1rem,5.6vw,4.1rem)] font-semibold leading-[0.98] tracking-tight text-ink">
              A persistent, browser-based
              <br />
              <span className="text-mint">sector simulation</span>
              <br />
              drawn flat.
            </h1>
            <p className="mt-5 max-w-xl text-[13px] leading-relaxed text-dim">
              Simplayz 1.0.0 renders the whole sector as a flat cartographic map: mountain, beach and sea are told apart by hue instead of
              shading. A seeded terrain engine still decides every cell underneath — drainage, soil, canopy and legacy sprawl are synthesised,
              stored in Postgres and surveyed by the same pure functions the server runs. Lock {config.claimSizeM} m of ground around your own
              coordinates, raise structures on a {config.gridCells}×{config.gridCells} grid, and keep the parcel for {config.lockHours} hours
              before anyone may contest it. Four glass themes, one flat world.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-2">
              <Link href="/world" className="btn btn-hot px-5 py-3 text-[12px]">CLAIM MY FIRST PARCEL →</Link>
              <Link href="/world" className="btn px-4 py-3">FLY THE SECTOR</Link>
              <span className="chip px-3 py-2 text-[10.5px] text-faint">{owned} parcel(s) held on this instance</span>
            </div>
          </div>

          <div className="panel p-4">
            <div className="label mb-3">instance ledger</div>
            <div className="grid grid-cols-2 gap-2">
              {stats.map(([label, value]) => (
                <div key={label} className="border border-line bg-glass/70 p-3">
                  <div className="label">{label}</div>
                  <div className="mt-1 text-[22px] leading-none tabular-nums text-ink">{value.toLocaleString()}</div>
                </div>
              ))}
              <div className="border border-mint/30 bg-mint/[0.06] p-3">
                <div className="label text-mint/70">tile zoom</div>
                <div className="mt-1 text-[22px] leading-none tabular-nums text-mint">z{config.tileZoom}</div>
              </div>
            </div>
            <div className="hairline my-4 h-px" />
            <div className="label mb-2">world_config · live from postgres</div>
            <dl className="space-y-1.5 text-[11px]">
              {[
                ["claim_size_m", `${config.claimSizeM} m (${((config.claimSizeM / 1000) ** 2).toFixed(2)} km²)`],
                ["lock_hours", `${config.lockHours} h`],
                ["max_claims", `${config.maxClaims} parcels / pilot`],
                ["grid_cells", `${config.gridCells} → ${(config.claimSizeM / config.gridCells).toFixed(1)} m cells`],
                ["terrain_seed", String(config.terrainSeed)],
                ["tick_minutes", `${config.tickMinutes} min economy tick`],
                ["assault_enabled", String(config.assaultEnabled)],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-1">
                  <dt className="text-faint">{k}</dt>
                  <dd className="tabular-nums text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <Link href="/world" className="btn mt-4 w-full py-2">OPEN WORLD CONFIG ADMIN</Link>
          </div>
        </div>
      </div>

      <section id="engine" className="mx-auto max-w-6xl px-6 py-16">
        <div className="label mb-6">the pipeline, end to end</div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            {
              n: "01",
              t: "Tile ingest",
              d: `An internal streamer pulls ${config.tileSource}/{z}/{x}/{y}.png with a compliant user agent, caches bytes in tile_cache for ${config.tileTtlHours} h, counts hits, and stamps X-Simplayz-Overlay when a tile carries player-authored parcels. Swap the source and the planet changes.`,
            },
            {
              n: "02",
              t: "Terrain hallucination",
              d: `${ENGINE_IDENTITY.model}. Evaluated in EPSG:3857 metres so the survey grid, the mesh and the tour physics agree without sync. Quantised into a ${config.gridCells}×${config.gridCells} grid and persisted, so a restart cannot reshape your land.`,
            },
            {
              n: "03",
              t: "Lock & build",
              d: `A pilot fixes a beacon (GPS or a chosen spawn) and locks ${config.claimSizeM} m of ground — ${config.maxClaims} parcels max. ${BUILD_KINDS.length} structure classes snap to the survey grid; water and cliff cells refuse construction, steep cells cost 60% more.`,
            },
            {
              n: "04",
              t: "Contest & tour",
              d: `After ${config.lockHours} h the seal breaks and neighbours file assaults resolved in four seeded phases. Between wars, the same scene switches to a first or third person walk so you can stand inside the thing you drew.`,
            },
          ].map((s) => (
            <div key={s.n} className="panel anim-sweep relative overflow-hidden p-4">
              <div className="text-[10px] tracking-[0.3em] text-mint">{s.n}</div>
              <h3 className="mt-2 text-[14px] text-ink">{s.t}</h3>
              <p className="mt-2 text-[11px] leading-relaxed text-dim">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-hull/60">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <div className="label mb-3">flat map legend · hue is the data</div>
            <div className="space-y-2">
              {legend.map((l) => (
                <div key={l.key} className="panel p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-ink">{l.label}</span>
                    <span className="text-[9px] uppercase tracking-[0.16em] text-faint">{l.key}</span>
                  </div>
                  <div className="mt-1.5 h-7 w-full border border-line/70" style={{ background: `linear-gradient(90deg, ${l.from}, ${l.to})` }} />
                  <div className="mt-1 text-[9.5px] text-faint">{l.note}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-dim">
              No relief exaggeration, no raster, no fog: the sector is drawn the way a cartographer would draw it.
              Elevation still drives gameplay — build cost, slope refusals and the survey profile are unchanged.
            </p>
          </div>
          <div>
            <div className="label mb-3">glass themes · selectable at runtime</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["dark purplish", "indigo ground · orchid accents"],
                ["light purplish", "paper-lilac ground · plum type"],
                ["custom colour", "your ground + your accent"],
                ["random high-contrast", "readability-checked rolls"],
              ].map(([name, note]) => (
                <div key={name} className="panel anim-floaty p-2.5">
                  <div className="text-[11px] text-ink">{name}</div>
                  <div className="mt-0.5 text-[9.5px] text-faint">{note}</div>
                </div>
              ))}
            </div>
            <div className="label mb-3 mt-6">build vocabulary</div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {BUILD_KINDS.slice(0, 9).map((k) => (
                <div key={k.key} className="pane p-2">
                  <span className="block h-5 w-full" style={{ background: `linear-gradient(150deg, ${k.color}, ${k.color}22)` }} />
                  <div className="mt-1 truncate text-[10px] text-ink">{k.name}</div>
                  <div className="text-[9px] text-faint">
                    {k.footprint[0]}×{k.footprint[1]} · {k.cost} cr
                  </div>
                </div>
              ))}
            </div>
            <Link href="/world" className="btn mt-3 inline-block px-3 py-2 text-[10px]">OPEN THE FLAT MAP →</Link>
          </div>
        </div>
      </section>

      <section id="rules" className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <h2 className="text-[clamp(1.5rem,3vw,2.2rem)] leading-tight text-ink">Sovereignty, expressed as a database row.</h2>
            <p className="mt-3 text-[12px] leading-relaxed text-dim">
              There is no hidden balance file. Parcel edge, lock window, claim ceiling, tile zoom, relief exaggeration, economy cadence and the
              terrain seed are one UPDATE away, and the client re-reads them on the next snapshot. Every claim you lose can be traced back to a
              row, a survey and a seeded resolution log.
            </p>
            <ul className="mt-5 space-y-2.5 text-[11.5px]">
              {[
                ["claim", "survey the ground with the engine, lock a parcel around your beacon, receive a sealed window"],
                ["economy", "each structure contributes income, upkeep, power, food, population and prestige, scored against the survey"],
                ["service", "dense and commercial builds need road adjacency or they run at 35% output; junctions lift the whole parcel"],
                ["assault", "after the seal, attackers resolve RECON → BREACH → HOLD → FLAG; winners take the parcel and its ruins"],
                ["tour", "the build scene and the walk scene are the same buffers — no second renderer, no second source of truth"],
              ].map(([k, v]) => (
                <li key={k} className="flex gap-3 border-b border-line/60 pb-2">
                  <span className="w-16 shrink-0 text-[9.5px] uppercase tracking-[0.2em] text-mint">{k}</span>
                  <span className="text-dim">{v}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="panel relative overflow-hidden p-5">
            <div className="label mb-2">resolution sample</div>
            <pre className="overflow-x-auto text-[10.5px] leading-relaxed text-dim">
{`POST /api/claims { action: "assault", claimId }

  guard      lock_until <= now()        -> else 409 SEALED
  survey     terrain_regions[claim:*]  -> defense modifier
  attack     60 + min(0.85, cr/9000)
               * 240 * (1 + rep/420) + recon*70
  defend     defense_score * (0.85..1.25)
               * (0.8 + terrain*0.25) + 30
  margin     attack - defend + hold*0.35 + flag*0.15
  outcome    ownership, lock_until = now + ${config.lockHours}h,
             credits loot, reputation, world_events row`}
            </pre>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[
                ["ticks", `${config.tickMinutes} min`],
                ["float", `${config.startCredits} cr`],
                ["relief", `×${config.reliefScale}`],
              ].map(([k, v]) => (
                <div key={k} className="border border-line bg-glass/70 p-2">
                  <div className="label">{k}</div>
                  <div className="text-[13px] text-ink">{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 text-[10px] uppercase tracking-[0.22em] text-faint">
          <span className="text-faint">Simplayz 1.0.0 · persistent sector simulation</span>
          <span>Next.js App Router · three.js · Drizzle · Postgres</span>
          <span className="ml-auto">flat cartography drawn from a seeded terrain engine</span>
        </div>
      </footer>
    </div>
    </ThemeHost>
  );
}
