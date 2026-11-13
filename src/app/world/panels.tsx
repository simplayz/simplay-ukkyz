"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BUILD_KINDS, CATEGORY_LABEL, footprintFor, type BuildCategory, type BuildKind } from "@/engine/buildings";
import { BIOMES, quickSample, sstep } from "@/engine/terrain";
import { computeTotals, lockCountdown } from "@/engine/simulation";
import { formatCoord, tileForLngLat } from "@/engine/geo";
import { KIND_MAP } from "@/engine/buildings";
import { SPAWNS, myClaims, useWorld } from "./store";
import { useTheme } from "../theme-store";
import { engineFocus, engineTeleport, type Telemetry } from "./viewport";
import { BASE_THEMES, type ThemeId } from "@/engine/themes";
import { CARTO_PALETTE, contrastRatio, paintFlatColor, swatches, type MapPalette } from "@/engine/palette";
import type { ClaimDTO, WorldConfigDTO } from "@/lib/types";

const CATEGORIES: BuildCategory[] = ["habitat", "food", "network", "commerce", "industry", "civic", "defense", "luxury"];

export function useTick(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Bar({ label, value, max, color = "#7df0c0" }: { label: string; value: number; max: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className="text-[11px] text-ink tabular-nums">{value}</span>
      </div>
      <div className="h-[3px] w-full bg-line/50">
        <div className="h-full" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 10px ${color}` }} />
      </div>
    </div>
  );
}

/* ------------------------------- top bar ------------------------------- */

export function TopBar({ telemetry }: { telemetry: Telemetry }) {
  const { config, player, mode, setMode, setPanel, timeOfDay, setTimeOfDay, hover, refresh, claims, mapLayers, setMapLayers } = useWorld();
  const themeName = useTheme((s) => s.theme.name);
  const now = useTick();
  const openTargets = claims.filter((c) => c.ownerId !== player?.id && lockCountdown(c.lockedUntil, now).open).length;
  const modes: { key: typeof mode; label: string; hint: string }[] = [
    { key: "bird", label: "BIRD", hint: "orbital survey camera" },
    { key: "build", label: "BUILD", hint: "parcel editor — click the grid to raise structures" },
    { key: "fps", label: "TOUR·FPS", hint: "first person — click the world to capture the mouse" },
    { key: "tps", label: "TOUR·TPS", hint: "third person chase camera" },
  ];
  return (
    <div className="pointer-events-auto panel relative z-20 flex flex-wrap items-center gap-x-5 gap-y-2 border-x-0 border-t-0 px-4 py-2">
      <div className="flex items-center gap-2">
        <div className="relative h-6 w-6 border border-mint/60">
          <div className="absolute inset-[3px] bg-mint/80" style={{ clipPath: "polygon(50% 0,100% 100%,0 100%)" }} />
        </div>
        <div className="leading-none">
          <div className="text-[13px] font-semibold tracking-[0.36em] text-ink">SIMPLAYZ</div>
          <div className="label mt-[3px]">sector OS · z{config.tileZoom} · {new Date(now).toISOString().slice(11, 19)}Z</div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {modes.map((m) => (
          <button key={m.key} title={m.hint} onClick={() => setMode(m.key)} className={`btn px-2.5 py-1.5 ${mode === m.key ? "btn-on" : ""}`}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="hidden items-center gap-3 text-[11px] text-dim lg:flex">
        <span className="chip px-2 py-1">{hover ? `${formatCoord(hover.lat, "lat")} ${formatCoord(hover.lng, "lng")}` : "aim the cursor at the world"}</span>
        <span className="chip px-2 py-1 tabular-nums">ELEV {hover ? `${hover.elev}m` : "—"}</span>
        <span className="chip px-2 py-1" style={{ borderColor: hover?.biomeColor }}>
          {hover?.biome ?? "BIOME —"}
        </span>
        <span className="chip px-2 py-1">TILE {hover ? `${hover.tile.z}/${hover.tile.x}/${hover.tile.y}` : "—"}</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="label">SUN</span>
          <input className="w-24" type="range" min={0} max={24} step={0.25} value={timeOfDay} onChange={(e) => setTimeOfDay(Number(e.target.value))} />
          <span className="w-12 text-[11px] tabular-nums text-dim">{`${String(Math.floor(timeOfDay)).padStart(2, "0")}:${String(Math.round((timeOfDay % 1) * 60)).padStart(2, "0")}`}</span>
        </div>
        <button className="btn px-2 py-1.5" onClick={() => setPanel("theme")} title="appearance — four glass themes">
          {themeName.toUpperCase()}
        </button>
        <div className="flex items-center gap-1" title="flat engine map + streamed OSM raster stacked on top">
          {([["flat", "FLAT"], ["stacked", "STACK"], ["raster", "RASTER"]] as const).map(([k, label]) => (
            <button key={k} className={`btn px-2 py-1.5 ${mapLayers === k ? "btn-on" : ""}`} onClick={() => setMapLayers(k)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn px-2 py-1.5" onClick={() => setPanel("intel")}>INTEL</button>
        <button className="btn px-2 py-1.5" onClick={() => setPanel("config")}>WORLD CONFIG</button>
        <button className="btn px-2 py-1.5" onClick={() => setPanel("help")}>?</button>
        <div className="chip flex items-center gap-2 px-2 py-1">
          <span className="h-2 w-2 rounded-full" style={{ background: player?.color ?? "#68b7ff" }} />
          <span className="text-[11px] text-ink">{player?.handle ?? "unregistered"}</span>
          <span className="text-[11px] text-amber tabular-nums">{(player?.credits ?? 0).toLocaleString()} cr</span>
        </div>
        <button className="btn px-2 py-1.5" onClick={() => void refresh()} title="re-pull the world snapshot">SYNC</button>
      </div>

      <div className="flex w-full items-center gap-4 border-t border-line/70 pt-1.5 text-[10px] uppercase tracking-[0.16em] text-faint">
        <span className="text-mint">{openTargets} open targets</span>
        <span>fps {telemetry.fps}</span>
        <span>draw {telemetry.draws}</span>
        <span>tris {(telemetry.tris / 1000).toFixed(0)}k</span>
        <span>tiles {telemetry.tiles}</span>
        <span className="text-faint">
          layer {telemetry.layers} · raster {telemetry.tileOpacity}% · src {telemetry.tileSource}
        </span>
        <span className={telemetry.overlay === "raw" ? "text-faint" : "text-amber"}>{telemetry.overlay}</span>
        <span>alt {telemetry.alt}m</span>
        <span>vel {telemetry.speed}m/s</span>
        <span className="ml-auto text-faint">hallucinator-9 · seed {config.terrainSeed}</span>
      </div>
    </div>
  );
}

/* ------------------------------- left rail ------------------------------- */

export function PilotConsole() {
  const { player, claims, config, activeClaimId, setActiveClaim, setPanel, setMode, hover, surveyPreview, surveyBusy, previewSurvey, claimAt, busy, center } = useWorld();
  const mine = myClaims(claims, player?.id ?? null);
  const [name, setName] = useState("");
  const [lng, setLng] = useState(center.lng.toFixed(5));
  const [lat, setLat] = useState(center.lat.toFixed(5));
  const now = useTick();

  useEffect(() => {
    if (hover) {
      setLng(hover.lng.toFixed(5));
      setLat(hover.lat.toFixed(5));
    }
  }, [hover?.tile.x, hover?.tile.y, hover?.buildingId, hover?.claimId]); // eslint-disable-line react-hooks/exhaustive-deps

  const goMyLocation = () => {
    if (!navigator.geolocation) return useWorld.getState().toast("this browser will not share a location — pick a spawn below", "warn");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLng(p.coords.longitude.toFixed(5));
        setLat(p.coords.latitude.toFixed(5));
        useWorld.getState().toast(`beacon fixed: ${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)}`, "good");
      },
      () => useWorld.getState().toast("location refused — pick a spawn below", "warn"),
      { enableHighAccuracy: false, timeout: 6000 },
    );
  };

  return (
    <div className="pointer-events-auto panel flex max-h-[62vh] w-[292px] flex-1 flex-col gap-3 overflow-y-auto border-y-0 border-l-0 p-3">
      <div>
        <div className="label">holdings</div>
        <div className="mt-1 flex items-end gap-2">
          <span className="text-2xl leading-none text-ink tabular-nums">{mine.length}</span>
          <span className="label mb-0.5">/ {config.maxClaims} parcels</span>
        </div>
        <div className="mt-1 h-[3px] w-full bg-line/50">
          <div className="h-full bg-mint" style={{ width: `${(mine.length / Math.max(1, config.maxClaims)) * 100}%` }} />
        </div>
      </div>

      <div className="hairline h-px" />

      <div className="space-y-1.5">
        {mine.length === 0 && <div className="text-[11px] leading-relaxed text-faint">No parcel held. Survey the ground, then lock 1 km² around a coordinate — the lock window is {config.lockHours}h.</div>}
        {mine.map((c) => (
          <ClaimCard key={c.id} claim={c} mine active={c.id === activeClaimId} onSelect={() => { setActiveClaim(c.id); setMode("build"); engineFocus(c.centerLng, c.centerLat, 520); }} now={now} />
        ))}
      </div>

      <div className="hairline h-px" />

      <div className="space-y-2">
        <div className="label">survey &amp; lock</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">lng</span>
            <input className="mt-0.5 w-full px-1.5 py-1 text-[11px]" value={lng} onChange={(e) => setLng(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">lat</span>
            <input className="mt-0.5 w-full px-1.5 py-1 text-[11px]" value={lat} onChange={(e) => setLat(e.target.value)} />
          </label>
        </div>
        <input className="w-full px-1.5 py-1 text-[11px]" placeholder="parcel name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex flex-wrap gap-1.5">
          <button className="btn px-2 py-1.5" onClick={goMyLocation}>MY LOCATION</button>
          <button
            className="btn px-2 py-1.5"
            disabled={surveyBusy}
            onClick={() => {
              const p = { lng: Number(lng), lat: Number(lat) };
              if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return useWorld.getState().toast("coordinates missing", "bad");
              void previewSurvey(p.lng, p.lat);
            }}
          >
            {surveyBusy ? "RUNNING…" : "RUN SURVEY"}
          </button>
          <button
            className="btn btn-hot px-2 py-1.5"
            disabled={busy === "claim" || !player || mine.length >= config.maxClaims}
            onClick={() => void claimAt(Number(lng), Number(lat), name || `Sector ${tileForLngLat(Number(lng), Number(lat), config.tileZoom).x}`)}
          >
            LOCK PARCEL
          </button>
        </div>
        {!player && <div className="text-[10px] text-rose/80">register a pilot before locking ground.</div>}
        {surveyPreview && <SurveyReadout survey={surveyPreview} />}
        <div className="text-[10px] text-faint">
          parcel edge {config.claimSizeM} m ({((config.claimSizeM / 1000) ** 2).toFixed(2)} km²) · grid {config.gridCells}×{config.gridCells} · cell {(config.claimSizeM / config.gridCells).toFixed(1)} m
        </div>
        <div className="flex flex-wrap gap-1">
          {SPAWNS.map((s) => (
            <button
              key={s.name}
              className="chip px-1.5 py-0.5 text-[10px] text-dim hover:border-mint hover:text-mint"
              onClick={() => {
                setLng(s.lng.toFixed(5));
                setLat(s.lat.toFixed(5));
                useWorld.getState().setCenter(s.lng, s.lat);
                engineFocus(s.lng, s.lat, 700);
              }}
            >
              {s.name.split(" ")[0]}
            </button>
          ))}
        </div>
        <button className="btn w-full py-1.5" onClick={() => setPanel("onboard")}>PILOT REGISTRATION</button>
      </div>

      <div className="hairline h-px" />

      <div className="space-y-1.5">
        <div className="label">contested / open targets</div>
        {claims.filter((c) => c.ownerId !== player?.id).length === 0 && <div className="text-[11px] text-faint">Nothing held by anyone else yet. You are alone on this planet.</div>}
        {claims
          .filter((c) => c.ownerId !== player?.id)
          .map((c) => (
            <ClaimCard
              key={c.id}
              claim={c}
              now={now}
              active={c.id === activeClaimId}
              onSelect={() => {
                setActiveClaim(c.id);
                engineFocus(c.centerLng, c.centerLat, 620);
              }}
            />
          ))}
      </div>
    </div>
  );
}

function SurveyReadout({ survey }: { survey: import("@/engine/terrain").SurveyResult }) {
  const p = survey.profile;
  return (
    <div className="space-y-2 border border-line bg-glass/80 p-2">
      <div className="flex items-center justify-between">
        <span className="label">engine survey</span>
        <span className="text-[10px] text-mint">{p.avgElevation}m avg · {p.avgSlope}° slope</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        <Bar label="farm" value={Math.round(p.farmScore * 100)} max={100} />
        <Bar label="build" value={Math.round(p.buildScore * 100)} max={100} color="#68b7ff" />
        <Bar label="defense" value={Math.round(p.defenseScore * 60)} max={100} color="#ffb454" />
        <Bar label="hydro" value={Math.round(p.hydro * 60)} max={100} color="#9ae66e" />
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-sm">
        {p.histogram.map((h) => (
          <div key={h.key} title={`${h.name} ${h.share}%`} style={{ width: `${h.share}%`, background: h.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {p.histogram.slice(0, 5).map((h) => (
          <span key={h.key} className="chip px-1 py-0.5 text-[9px]" style={{ borderColor: h.color, color: "#aebfc7" }}>
            {h.name} {h.share}%
          </span>
        ))}
      </div>
      <div className="text-[10px] text-faint">water {Math.round(p.waterFraction * 100)}% · canopy {Math.round(p.forestFraction * 100)}% · minerals {p.minerals.toFixed(2)}</div>
    </div>
  );
}

function ClaimCard({ claim, mine, active, onSelect, now }: { claim: ClaimDTO; mine?: boolean; active?: boolean; onSelect: () => void; now: number }) {
  const { assaultClaim, relockClaim, abandonClaim, busy, config } = useWorld();
  const lock = lockCountdown(claim.lockedUntil, now);
  const totals = computeTotals(claim.buildings, null, config.gridCells);
  return (
    <div className={`border p-2 transition ${active ? "border-mint/70 bg-mint/[0.06]" : "border-line bg-glass/70 hover:border-dim/60"}`}>
      <button className="w-full text-left" onClick={onSelect}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[12px] text-ink">{claim.name}</span>
          <span className={`shrink-0 text-[10px] tabular-nums ${lock.open ? "text-amber" : "text-ice"}`}>{lock.label}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-faint">
          <span style={{ color: claim.owner?.color ?? "#6c8794" }}>{claim.owner?.handle ?? "unclaimed"}</span>
          <span>·</span>
          <span>{claim.buildings.length} structures</span>
          <span>·</span>
          <span>{claim.sizeM}m</span>
        </div>
        <div className="mt-1 grid grid-cols-4 gap-1 text-center">
          {[
            ["POP", mine ? totals.population : claim.population],
            ["CR/T", mine ? totals.netIncome : claim.income],
            ["DEF", mine ? totals.defense : claim.defenseScore],
            ["PR", claim.prestige],
          ].map(([k, v]) => (
            <div key={String(k)} className="bg-glass py-0.5">
              <div className="label">{k}</div>
              <div className="text-[11px] tabular-nums text-ink">{Number(v)}</div>
            </div>
          ))}
        </div>
      </button>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <button className="btn px-1.5 py-1" onClick={() => engineFocus(claim.centerLng, claim.centerLat, 460)}>FLY</button>
        {mine ? (
          <>
            <button className="btn px-1.5 py-1" disabled={busy !== null} onClick={() => void relockClaim(claim.id)}>RELOCK 900cr</button>
            <button className="btn px-1.5 py-1 text-rose hover:border-rose" disabled={busy !== null} onClick={() => window.confirm(`Abandon ${claim.name}?`) && void abandonClaim(claim.id)}>ABANDON</button>
          </>
        ) : (
          <button
            className={`btn px-1.5 py-1 ${lock.open ? "btn-hot" : ""}`}
            disabled={!lock.open || busy === "assault" || !config.assaultEnabled}
            title={lock.open ? "lock window expired — assault allowed" : `sealed for ${lock.label}`}
            onClick={() => void assaultClaim(claim.id)}
          >
            {lock.open ? "ASSAULT" : "SEALED"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- right rail ------------------------------- */

export function BuildPalette() {
  const { config, claims, activeClaimId, selectedKind, setSelectedKind, tool, setTool, rotation, rotate, player } = useWorld();
  const [cat, setCat] = useState<BuildCategory | "all">("all");
  const claim = claims.find((c) => c.id === activeClaimId);
  const mine = claim && claim.ownerId === player?.id ? claim : null;
  const list = useMemo(() => (cat === "all" ? BUILD_KINDS : BUILD_KINDS.filter((k) => k.category === cat)), [cat]);

  return (
    <div className="pointer-events-auto panel flex w-[300px] flex-col gap-2 overflow-hidden border-y-0 border-r-0 p-3">
      <div className="flex items-center justify-between">
        <span className="label">build palette</span>
        <div className="flex gap-1">
          {(["build", "demolish", "inspect"] as const).map((t) => (
            <button key={t} className={`btn px-1.5 py-1 ${tool === t ? "btn-on" : ""}`} onClick={() => setTool(t)}>
              {t === "build" ? "RAISE" : t === "demolish" ? "SALVAGE" : "LOOK"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={`chip px-1.5 py-0.5 text-[10px] ${cat === "all" ? "border-mint text-mint" : "text-dim"}`} onClick={() => setCat("all")}>
          ALL
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} className={`chip px-1.5 py-0.5 text-[10px] ${cat === c ? "border-mint text-mint" : "text-dim"}`} onClick={() => setCat(c)}>
            {CATEGORY_LABEL[c].toUpperCase()}
          </button>
        ))}
      </div>

      {!mine && <div className="border border-amber/40 bg-amber/10 p-2 text-[10px] leading-relaxed text-amber">Select one of your parcels to edit. Foreign ground is read-only until you take it by assault.</div>}

      <div className="-mr-1 grid flex-1 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
        {list.map((k) => {
          const selected = selectedKind === k.key;
          const [w, d] = footprintFor(k, rotation);
          const afford = (player?.credits ?? 0) >= k.cost;
          return (
            <button
              key={k.key}
              title={`${k.blurb}\n\nfootprint ${w}×${d} cells · ${k.cost} cr`}
              onClick={() => setSelectedKind(selected ? null : k.key)}
              className={`group relative border p-1.5 text-left transition ${selected ? "border-mint bg-mint/10" : afford ? "border-line bg-glass/70 hover:border-dim/60" : "border-line/50 bg-glass/40 opacity-50"}`}
            >
              <span className="block h-8 w-full" style={{ background: `linear-gradient(160deg, ${k.color}, ${k.color}22)`, boxShadow: `inset 0 0 0 1px ${k.color}55` }} />
              <span className="mt-1 block truncate text-[10.5px] leading-tight text-ink">{k.name}</span>
              <span className="flex items-center justify-between text-[9.5px] text-faint">
                <span>{w}×{d} · {Math.round(k.floorHeight * k.storeys)}m</span>
                <span className={afford ? "text-amber" : "text-rose"}>{k.cost}</span>
              </span>
            </button>
          );
        })}
      </div>

      {selectedKind && KIND_MAP[selectedKind] && (
        <div className="border border-mint/40 bg-mint/[0.05] p-2 text-[10px] leading-relaxed text-dim">
          <div className="flex items-center justify-between">
            <span className="text-mint">{KIND_MAP[selectedKind].name}</span>
            <button className="btn px-1.5 py-0.5" onClick={rotate}>ROT {rotation * 90}°</button>
          </div>
          <p className="mt-1 text-dim">{KIND_MAP[selectedKind].blurb}</p>
          <div className="mt-1 grid grid-cols-3 gap-1 text-center">
            {(["income", "population", "defense", "power", "food", "prestige"] as const).map((f) => (
              <div key={f}>
                <div className="label">{f.slice(0, 3).toUpperCase()}</div>
                <div className="text-[11px] tabular-nums text-ink">{KIND_MAP[selectedKind][f]}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="text-[10px] text-faint">Click the parcel grid to place · R rotates · salvage mode clicks a structure to demolish it.</div>
    </div>
  );
}

export function ParcelInspector() {
  const { claims, activeClaimId, config, player, upgrade, setMode } = useWorld();
  const claim = claims.find((c) => c.id === activeClaimId);
  const now = useTick(2000);
  if (!claim) return <div className="panel pointer-events-auto border-y-0 border-r-0 p-3 text-[11px] text-faint w-[300px]">no parcel selected</div>;
  const totals = computeTotals(claim.buildings, null, config.gridCells);
  const mine = claim.ownerId === player?.id;
  const lock = lockCountdown(claim.lockedUntil, now);
  return (
    <div className="pointer-events-auto panel flex max-h-[46vh] w-[300px] flex-col gap-2 overflow-hidden border-y-0 border-r-0 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-ink">{claim.name}</span>
        <span className="label">{claim.status} · {lock.open ? "OPEN" : `SEALED ${lock.label}`}</span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-center">
        {[
          ["ELEV", `${claim.profile.avgElevation}m`],
          ["SLOPE", `${claim.profile.avgSlope}°`],
          ["WATER", `${Math.round(claim.profile.waterFraction * 100)}%`],
          ["FARM", claim.profile.farmScore.toFixed(2)],
          ["CANOPY", `${Math.round(claim.profile.forestFraction * 100)}%`],
          ["DEF", String(claim.defenseScore)],
        ].map(([k, v]) => (
          <div key={k} className="bg-glass px-1 py-1">
            <div className="label">{k}</div>
            <div className="text-[11px] tabular-nums text-ink">{v}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Bar label={`income ${totals.netIncome >= 0 ? "+" : ""}${totals.netIncome}/tick`} value={Math.max(0, totals.netIncome)} max={300} />
        <Bar label={`power ${totals.power}`} value={Math.max(0, totals.power)} max={140} color="#ffb454" />
        <Bar label="population" value={totals.population} max={500} color="#68b7ff" />
        <Bar label="prestige" value={claim.prestige} max={200} color="#c5a3ff" />
      </div>
      {totals.disconnected.length > 0 && <div className="border border-amber/40 bg-amber/10 px-2 py-1 text-[10px] text-amber">{totals.disconnected.join(", ")} lack road service — output at 35%</div>}
      <div className="flex gap-1">
        <button className="btn flex-1 py-1" onClick={() => setMode(mine ? "build" : "tps")}>{mine ? "TO BUILD" : "TO TOUR"}</button>
        <button className="btn flex-1 py-1" onClick={() => { useWorld.getState().setMode("fps"); engineTeleport(claim.centerLng, claim.centerLat); }}>WALK IN</button>
      </div>
      <div className="label">structures · {claim.buildings.length}</div>
      <div className="-mr-1 flex-1 space-y-1 overflow-y-auto pr-1">
        {claim.buildings.length === 0 && <div className="text-[10px] text-faint">bare ground. raise something.</div>}
        {claim.buildings.map((b) => {
          const k = KIND_MAP[b.kind];
          if (!k) return null;
          return (
            <div key={b.id} className="flex items-center gap-2 border border-line bg-glass/60 px-1.5 py-1">
              <span className="h-2.5 w-2.5 shrink-0" style={{ background: k.color }} />
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-dim">{k.name}</span>
              <span className="text-[9.5px] text-faint">T{b.level}</span>
              <span className="text-[9.5px] text-mint tabular-nums">{k.income * b.level}</span>
              {mine && (
                <button className="btn px-1 py-0.5 text-[9px]" disabled={b.level >= 5} onClick={() => void upgrade(claim.id, b.id)}>
                  UP
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------- minimap -------------------------------- */

export function Minimap() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { center, claims, config, hover } = useWorld();
  const themeMap = useTheme((s) => s.theme.map);
  const mapStyle = useTheme((s) => s.mapStyle);
  const [size] = useState(176);
  // the minimap is a tiny copy of the flat map: same painter, same ramps
  const palette = mapStyle === "themed" ? themeMap : CARTO_PALETTE;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext("2d");
    if (!g) return;
    const res = 56;
    c.width = size;
    c.height = size;
    const span = config.claimSizeM * 3.4;
    g.fillStyle = palette.land[0];
    g.fillRect(0, 0, size, size);
    const cell = size / res;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const east = (x / res - 0.5) * span;
        const south = (y / res - 0.5) * span;
        const lng = center.lng + east / (111320 * Math.cos((center.lat * Math.PI) / 180));
        const lat = center.lat - south / metersPerDegLat;
        const s = quickSample(lng, lat, config.terrainSeed);
        const rgb = paintFlatColor(palette, {
          h: s.h,
          wet: s.wet,
          forest: s.forest,
          urban: s.urban,
          river: s.river,
          biome: s.biome,
          classified: s.biome,
        });
        g.fillStyle = `rgb(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)})`;
        g.fillRect(x * cell, y * cell, cell + 0.6, cell + 0.6);
      }
    }
    for (const cl of claims) {
      const east = ((cl.centerLng - center.lng) * 111320 * Math.cos((center.lat * Math.PI) / 180));
      const south = -(cl.centerLat - center.lat) * 110540;
      const px = size / 2 + (east / span) * size;
      const py = size / 2 + (south / span) * size;
      const side = (cl.sizeM / span) * size;
      const mine = cl.ownerId && cl.ownerId === useWorld.getState().player?.id;
      g.strokeStyle = cl.ownerId ? (mine ? "#7df0c0" : cl.owner?.color ?? "#ffb454") : "#ffb454";
      g.lineWidth = 1.2;
      g.strokeRect(px - side / 2, py - side / 2, side, side);
      g.fillStyle = cl.ownerId ? "rgba(125,240,192,0.18)" : "rgba(255,180,84,0.16)";
      g.fillRect(px - side / 2, py - side / 2, side, side);
    }
    if (hover) {
      const east = (hover.lng - center.lng) * 111320 * Math.cos((center.lat * Math.PI) / 180);
      const south = -(hover.lat - center.lat) * 110540;
      g.fillStyle = "rgba(255,255,255,0.95)";
      g.strokeStyle = "rgba(0,0,0,0.55)";
      g.lineWidth = 1;
      const hx = size / 2 + (east / span) * size;
      const hy = size / 2 + (south / span) * size;
      g.fillRect(hx - 1.5, hy - 1.5, 3, 3);
      g.strokeRect(hx - 2, hy - 2, 4, 4);
    }
  }, [center.lng, center.lat, claims, config.terrainSeed, config.claimSizeM, hover?.tile.x, hover?.tile.y, size, palette]);

  return (
    <div className="panel pointer-events-auto p-1.5">
      <canvas
        ref={ref}
        style={{ width: size, height: size }}
        className="cursor-crosshair"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const span = config.claimSizeM * 3.4;
          const east = ((e.clientX - r.left) / r.width - 0.5) * span;
          const south = ((e.clientY - r.top) / r.height - 0.5) * span;
          const lng = center.lng + east / (111320 * Math.cos((center.lat * Math.PI) / 180));
          const lat = center.lat - south / 110540;
          engineFocus(lng, lat, 620);
          useWorld.getState().setCenter(lng, lat);
        }}
      />
      <div className="label mt-1 text-center">sector {tileForLngLat(center.lng, center.lat, config.tileZoom).x}/{tileForLngLat(center.lng, center.lat, config.tileZoom).y}</div>
    </div>
  );
}

const metersPerDegLat = 110540;

/* -------------------------------- ticker -------------------------------- */

export function EventTicker() {
  const events = useWorld((s) => s.events);
  const items = events.slice(0, 14);
  return (
    <div className="panel pointer-events-auto relative z-10 flex items-center gap-3 border-x-0 border-b-0 px-3 py-1.5">
      <span className="label shrink-0 text-mint">world feed</span>
      <div className="relative flex-1 overflow-hidden">
        <div className="flex w-max gap-8 whitespace-nowrap anim-ticker">
          {[...items, ...items].map((e, i) => (
            <span key={`${e.id}-${i}`} className="text-[10.5px] text-dim">
              <span className="text-faint">{new Date(e.createdAt).toISOString().slice(11, 16)}</span>{" "}
              <span className={e.type === "assault" ? "text-rose" : e.type === "build" ? "text-mint/80" : "text-dim"}>[{e.type}]</span> {e.message}
            </span>
          ))}
          {items.length === 0 && <span className="text-[10.5px] text-faint">no records yet — the feed fills as pilots lock ground.</span>}
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useWorld((s) => s.toasts);
  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`anim-rise border px-3 py-1.5 text-[11px] backdrop-blur ${
            t.tone === "good" ? "border-mint/60 bg-mint/10 text-mint" : t.tone === "bad" ? "border-rose/60 bg-rose/10 text-rose" : t.tone === "warn" ? "border-amber/60 bg-amber/10 text-amber" : "border-line bg-hull/80 text-dim"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------- modals -------------------------------- */

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-void/80 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className={`panel anim-rise relative max-h-[86vh] overflow-y-auto p-5 ${wide ? "w-[760px]" : "w-[460px]"} max-w-full`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] tracking-[0.3em] text-ink">{title}</h2>
          <button className="btn px-2 py-1" onClick={onClose}>
            CLOSE
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function OnboardModal() {
  const { register, busy, setPanel, panel } = useWorld();
  const [handle, setHandle] = useState("");
  const [spawn, setSpawn] = useState(SPAWNS[0]);
  const [geo, setGeo] = useState<{ lng: number; lat: number } | null>(null);
  if (panel !== "onboard") return null;
  return (
    <Modal title="PILOT REGISTRATION" onClose={() => setPanel(null)}>
      <div className="space-y-3 text-[11px] leading-relaxed text-dim">
        <p>Simplayz keeps no password file. A pilot id is minted, stored locally, and used as a bearer token for the ledger.</p>
        <label className="block">
          <span className="label">handle</span>
          <input autoFocus className="mt-1 w-full px-2 py-1.5 text-[12px]" placeholder="e.g. kite-warden-9F2" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </label>
        <div>
          <span className="label">spawn sector</span>
          <div className="mt-1 grid grid-cols-2 gap-1.5">
            {SPAWNS.map((s) => (
              <button key={s.name} className={`chip px-2 py-1.5 text-left text-[10.5px] ${spawn.name === s.name ? "border-mint text-mint" : "text-dim"}`} onClick={() => setSpawn(s)}>
                {s.name}
                <div className="text-[9px] text-faint">{s.lat.toFixed(3)}, {s.lng.toFixed(3)}</div>
              </button>
            ))}
          </div>
        </div>
        <button
          className="btn w-full py-1.5"
          onClick={() =>
            navigator.geolocation?.getCurrentPosition(
              (p) => {
                const g = { lng: p.coords.longitude, lat: p.coords.latitude };
                setGeo(g);
                setSpawn({ name: "MY LOCATION", lng: g.lng, lat: g.lat });
              },
              () => useWorld.getState().toast("browser refused the location — pick a spawn sector", "warn"),
            )
          }
        >
          USE MY GPS FIX
        </button>
        <button className="btn btn-hot w-full py-2" disabled={busy === "pilot"} onClick={() => void register(handle || `pilot-${Math.floor(Math.random() * 900 + 100)}`, geo ?? { lng: spawn.lng, lat: spawn.lat })}>
          ENTER THE SIMULATION
        </button>
      </div>
    </Modal>
  );
}

export function ConfigModal() {
  const { config, saveConfig, busy, setPanel, panel } = useWorld();
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);
  if (panel !== "config") return null;
  const num = (k: keyof typeof draft, label: string, hint: string, step = 1) => (
    <label className="block">
      <span className="label">{label}</span>
      <input
        type="number"
        step={step}
        className="mt-1 w-full px-2 py-1 text-[12px]"
        value={String(draft[k] ?? "")}
        onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) } as WorldConfigDTO)}
      />
      <span className="mt-0.5 block text-[9.5px] text-faint">{hint}</span>
    </label>
  );
  return (
    <Modal title="WORLD CONFIG · Postgres row world_config" onClose={() => setPanel(null)} wide>
      <div className="grid grid-cols-3 gap-3 text-dim">
        {num("claimSizeM", "parcel edge (m)", "1 km² == 1000. Drives the grid cell size.")}
        {num("lockHours", "lock window (h)", "hours before another pilot may assault.")}
        {num("maxClaims", "max parcels / pilot", "hard ceiling enforced on claim.")}
        {num("gridCells", "grid resolution", "cells per axis (48 → 20.8 m cells).")}
        {num("tileZoom", "OSM zoom", "tile streamer level.")}
        {num("reliefScale", "relief exaggeration", "vertical scale of the generated mesh.", 0.05)}
        {num("tickMinutes", "economy tick (min)", "credits accrual cadence.")}
        {num("terrainCacheSeconds", "survey cache (s)", "how long a generated grid stays authoritative.")}
        {num("tileTtlHours", "tile TTL (h)", "internal streamer cache lifetime.")}
        {num("startCredits", "pilot float (cr)", "credits minted at registration.")}
        {num("terrainSeed", "terrain seed", "re-hallucinate the planet by changing it.")}
        <label className="block">
          <span className="label">tile source</span>
          <input className="mt-1 w-full px-2 py-1 text-[11px]" value={draft.tileSource} onChange={(e) => setDraft({ ...draft, tileSource: e.target.value })} />
          <span className="mt-0.5 block text-[9.5px] text-faint">upstream raster consumed by the streamer.</span>
        </label>
        <label className="col-span-3 flex items-center gap-2 border border-line bg-glass/70 p-2 text-[11px]">
          <input type="checkbox" checked={draft.assaultEnabled} onChange={(e) => setDraft({ ...draft, assaultEnabled: e.target.checked })} />
          allow assaults after the lock window
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn btn-hot px-3 py-1.5" disabled={busy === "config"} onClick={() => void saveConfig(draft)}>
          WRITE TO POSTGRES
        </button>
        <button className="btn px-3 py-1.5" onClick={() => void saveConfig({ terrainSeed: Math.floor(Math.random() * 90_000_000) + 1000 })}>
          RE-HALLUCINATE TERRAIN
        </button>
        <button className="btn px-3 py-1.5" onClick={() => void saveConfig({ claimSizeM: 1000, lockHours: 72, maxClaims: 3, tileZoom: 15, reliefScale: 1.35, gridCells: 48 })}>
          RESET BRIEF DEFAULTS
        </button>
        <span className="text-[10px] text-faint">changing relief or seed rebuilds every mesh in the sector.</span>
      </div>
    </Modal>
  );
}

export function IntelModal() {
  const leaderboard = useWorld((s) => s.leaderboard);
  const events = useWorld((s) => s.events);
  const stats = useWorld((s) => s.stats);
  const claims = useWorld((s) => s.claims);
  const player = useWorld((s) => s.player);
  const { setPanel, panel } = useWorld();
  if (panel !== "intel") return null;
  return (
    <Modal title="INTEL · ledger, feed, engine" onClose={() => setPanel(null)} wide>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="label mb-1.5">ledger</div>
          <table className="w-full text-[11px]">
            <tbody>
              {leaderboard.length === 0 && <tr><td className="py-1 text-faint">no pilots registered</td></tr>}
              {leaderboard.map((r, i) => (
                <tr key={r.id} className={`border-b border-line/60 ${r.id === player?.id ? "text-mint" : "text-dim"}`}>
                  <td className="py-1 pr-1 text-faint">{String(i + 1).padStart(2, "0")}</td>
                  <td className="py-1"><span className="mr-1.5 inline-block h-2 w-2" style={{ background: r.color }} />{r.handle}</td>
                  <td className="py-1 text-right tabular-nums">{r.claims}/{r.max ?? 3}</td>
                  <td className="py-1 text-right tabular-nums">{r.credits.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums text-faint">{r.reputation} rep</td>
                  <td className="py-1 pl-2 text-right text-[10px] text-faint">{r.victories}W/{r.losses}L</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="label mb-1.5">world telemetry</div>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              ["pilots", stats.players],
              ["parcels", stats.claims],
              ["structures", stats.structures],
              ["tiles cached", stats.tilesCached],
              ["tile hits", stats.tilesServed],
              ["surveys", stats.surveys],
            ].map(([k, v]) => (
              <div key={String(k)} className="border border-line bg-glass/70 p-2">
                <div className="label">{k}</div>
                <div className="text-[15px] tabular-nums text-ink">{Number(v).toLocaleString()}</div>
              </div>
            ))}
          </div>
          <div className="label mb-1.5 mt-3">feed</div>
          <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {events.map((e) => (
              <div key={e.id} className="text-[10.5px] leading-snug text-dim">
                <span className="text-faint">{new Date(e.createdAt).toISOString().slice(5, 16).replace("T", " ")}</span> {e.message}
              </div>
            ))}
            {events.length === 0 && <div className="text-[10.5px] text-faint">quiet.</div>}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {claims.slice(0, 6).map((c) => (
          <button key={c.id} className="chip px-2 py-1 text-[10px] text-dim hover:border-mint hover:text-mint" onClick={() => { engineFocus(c.centerLng, c.centerLat, 520); useWorld.getState().setActiveClaim(c.id); }}>
            {c.name} · {c.buildings.length}s
          </button>
        ))}
      </div>
    </Modal>
  );
}

function useNoop() {
  return null;
}
void useNoop();

export function HelpModal() {
  const { panel, setPanel } = useWorld();
  if (panel !== "help") return null;
  return (
    <Modal title="CONTROLS & PROTOCOL" onClose={() => setPanel(null)} wide>
      <div className="grid grid-cols-2 gap-5 text-[11px] leading-relaxed text-dim">
        <div>
          <div className="label mb-1">camera</div>
          <ul className="space-y-1">
            <li><b className="text-ink">drag LMB</b> — pan the sector</li>
            <li><b className="text-ink">drag RMB / shift+drag</b> — orbit yaw &amp; pitch</li>
            <li><b className="text-ink">wheel</b> — dolly · <b className="text-ink">Q / E</b> — slow orbit</li>
            <li>cursor over ground reports coordinate, elevation, biome and tile id from the engine</li>
          </ul>
          <div className="label mb-1 mt-3">build mode</div>
          <ul className="space-y-1">
            <li>pick a structure, <b className="text-ink">click a cell</b> on your parcel to raise it</li>
            <li><b className="text-ink">R</b> rotates the footprint · SALVAGE tool demolishes on click</li>
            <li>water and cliff cells are refused; steep cells cost 60% more</li>
            <li>food needs farm score ≥ its threshold; dense builds need road adjacency or they run at 35%</li>
          </ul>
        </div>
        <div>
          <div className="label mb-1">tour mode</div>
          <ul className="space-y-1">
            <li><b className="text-ink">click the world</b> to capture the mouse · <b className="text-ink">Esc</b> releases</li>
            <li><b className="text-ink">WASD</b> walk · <b className="text-ink">Shift</b> sprint · <b className="text-ink">Space</b> hop</li>
            <li>ground, slope and biome come from the same survey the server scored</li>
          </ul>
          <div className="label mb-1 mt-3">sovereignty rules</div>
          <ul className="space-y-1">
            <li>parcel edge = <b className="text-ink">world_config.claim_size_m</b> (1 km² by default)</li>
            <li>a parcel is <b className="text-ink">sealed</b> for the configured lock window (72 h)</li>
            <li>after the seal expires anyone may assault; the engine resolves RECON → BREACH → HOLD → FLAG</li>
            <li>max parcels per pilot = <b className="text-ink">max_claims</b>; all three numbers live in Postgres</li>
          </ul>
        </div>
      </div>
    </Modal>
  );
}

export function AssaultReport() {
  const { lastReport, setPanel } = useWorld();
  if (!lastReport) return null;
  const r = lastReport as unknown as {
    success: boolean;
    attackerPower: number;
    defenderPower: number;
    margin: number;
    loot: number;
    reputationDelta: number;
    narrative: string;
    phases: { name: string; roll: number; note: string }[];
  };
  return (
    <div className="pointer-events-auto absolute left-1/2 top-20 z-40 w-[520px] max-w-[92vw] -translate-x-1/2 anim-rise">
      <div className={`panel border-l-2 p-3 ${r.success ? "border-l-mint" : "border-l-rose"}`}>
        <div className="flex items-center justify-between">
          <span className={`text-[12px] tracking-[0.24em] ${r.success ? "text-mint" : "text-rose"}`}>{r.success ? "PARCEL SEIZED" : "ASSAULT REPELLED"}</span>
          <button className="btn px-1.5 py-0.5 text-[9px]" onClick={() => { useWorld.setState({ lastReport: null }); setPanel(null); }}>DISMISS</button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-dim">{r.narrative}</p>
        <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
          <div className="bg-glass p-1.5"><div className="label">attack</div><div className="text-[13px] tabular-nums text-ink">{r.attackerPower}</div></div>
          <div className="bg-glass p-1.5"><div className="label">defense</div><div className="text-[13px] tabular-nums text-ink">{r.defenderPower}</div></div>
          <div className="bg-glass p-1.5"><div className="label">margin</div><div className={`text-[13px] tabular-nums ${r.margin > 0 ? "text-mint" : "text-rose"}`}>{r.margin}</div></div>
          <div className="bg-glass p-1.5"><div className="label">credits</div><div className={`text-[13px] tabular-nums ${r.loot >= 0 ? "text-amber" : "text-rose"}`}>{r.loot >= 0 ? "+" : ""}{r.loot}</div></div>
        </div>
        <div className="mt-2 flex gap-1.5">
          {r.phases.map((p) => (
            <div key={p.name} className="flex-1 border border-line px-1.5 py-1">
              <div className="label">{p.name}</div>
              <div className="mt-0.5 h-[3px] bg-line/50"><div className="h-full bg-ice" style={{ width: `${Math.round(p.roll * 100)}%` }} /></div>
              <div className="mt-0.5 text-[9px] text-faint">{Math.round(p.roll * 100)}%</div>
            </div>
          ))}
        </div>
        <div className="mt-1.5 text-[10px] text-faint">reputation {r.reputationDelta >= 0 ? "+" : ""}{r.reputationDelta} · deterministic resolution, seeded by the ledger, replayable in world_events</div>
      </div>
    </div>
  );
}

export function KindBadge(kind: BuildKind) {
  return <span className="chip px-1 text-[9px]" style={{ color: kind.color }}>{kind.name}</span>;
}

/* ------------------------- site advisory agent ------------------------- */

interface Advice {
  id: string;
  tone: "good" | "warn" | "bad" | "info";
  title: string;
  detail: string;
  kind?: string;
  count?: number;
}

/**
 * A tiny deterministic agent: it reads the same survey + totals the server
 * scored, evaluates a rule stack and hands the player actionable build orders.
 * No network, no vibes — every line is traceable to a number in the ledger.
 */
function advise(claim: ClaimDTO | undefined, totals: ReturnType<typeof computeTotals>, credits: number, lockHoursLeft: number, maxed: boolean): Advice[] {
  const out: Advice[] = [];
  if (!claim) {
    return [{ id: "boot", tone: "warn", title: "no parcel selected", detail: "Run a survey, then lock 1 km² around your beacon. Everything else in this panel unlocks after that." }];
  }
  const p = claim.profile;
  if (claim.buildings.length === 0) {
    out.push({ id: "seed", tone: "warn", title: "ground is bare", detail: "Two Pod Dwellings plus a Field Strip gets the tick positive on almost any survey.", kind: "dwelling", count: 2 });
    out.push({ id: "road", tone: "info", title: "lay the frame first", detail: "Roads are 70 cr a pop and every later structure needs adjacency. Grid them before you decorate.", kind: "road", count: 6 });
  }
  if (totals.power < 0) out.push({ id: "power", tone: "bad", title: `power deficit ${totals.power} MW`, detail: `Raise ${Math.ceil(-totals.power / 34)} Photon Field(s) — the vaults and fab lines are throttling without them.`, kind: "solar", count: Math.ceil(-totals.power / 34) });
  if (totals.disconnected.length > 0) out.push({ id: "service", tone: "bad", title: `${totals.disconnected.length} structure(s) off-network`, detail: `${totals.disconnected.slice(0, 3).join(", ")} run at 35% until a road cell touches their footprint.`, kind: "road", count: totals.disconnected.length * 2 });
  const foodPerHead = claim.buildings.length ? totals.food / Math.max(1, totals.population) : 1;
  if (totals.population > 40 && foodPerHead < 0.6) out.push({ id: "food", tone: "warn", title: "calories thin for the population", detail: p.farmScore < 0.45 ? "Soil score is poor here — a Hydro Vault beats more open field strips." : "Field Strips are the cheapest fix at this farm score.", kind: p.farmScore < 0.45 ? "greenhouse" : "farm", count: 2 });
  if (lockHoursLeft < 12 && totals.defense < 160) out.push({ id: "seal", tone: "bad", title: `seal breaks in ${lockHoursLeft.toFixed(1)} h`, detail: `Defense ${totals.defense}. Two Watch Spires plus a berm chain roughly doubles it.`, kind: "watchtower", count: 2 });
  if (credits > 2400 && !claim.buildings.some((b) => b.kind === "beacon")) out.push({ id: "flag", tone: "good", title: "float is heavy", detail: "A Claim Beacon buys 30 prestige and 16 defense — the cheapest status on the grid.", kind: "beacon", count: 1 });
  if (p.avgSlope > 16) out.push({ id: "slope", tone: "info", title: "steep survey", detail: `Average slope ${p.avgSlope}°: terraced pads cost 60% more. Level ground for the fab line, put parks on the pitch.` });
  if (maxed) out.push({ id: "ceiling", tone: "warn", title: "claim ceiling reached", detail: "You hold the maximum parcels. Abandon the weakest or relock it before someone else takes the calculation." });
  if (out.length === 0) out.push({ id: "idle", tone: "good", title: "ledger is clean", detail: "Tick is positive, network is served, seal holds. Tour mode is free real estate." });
  return out.slice(0, 4);
}

export function AdvisorAgent() {
  const { claims, activeClaimId, config, player, setSelectedKind, setMode } = useWorld();
  const now = useTick(15000);
  const [thinking, setThinking] = useState(false);
  const [pass, setPass] = useState(0);
  const claim = claims.find((c) => c.id === activeClaimId);
  const totals = computeTotals(claim?.buildings ?? [], null, config.gridCells);
  const lock = claim ? lockCountdown(claim.lockedUntil, now) : { label: "—", open: true, remaining: 0 };
  const lockHoursLeft = lock.remaining / 3600000;
  const advice = useMemo(
    () => advise(claim, totals, player?.credits ?? 0, lockHoursLeft, (claims.filter((c) => c.ownerId === player?.id).length ?? 0) >= config.maxClaims),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [claim?.id, claim?.buildings.length, player?.credits, lock.label, config.maxClaims, claims.length],
  );
  const mine = claim && claim.ownerId === player?.id;

  return (
    <div className="panel pointer-events-auto w-[292px] p-3">
      <div className="flex items-center justify-between">
        <span className="label">site agent · rule stack v4</span>
        <span className={`text-[9px] ${thinking ? "text-mint anim-blink" : "text-faint"}`}>{thinking ? "evaluating" : `pass ${pass}`}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {advice.map((a) => (
          <div key={a.id} className={`border-l-2 bg-glass/70 px-2 py-1.5 ${a.tone === "bad" ? "border-l-rose" : a.tone === "warn" ? "border-l-amber" : a.tone === "good" ? "border-l-mint" : "border-l-ice"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-ink">{a.title}</span>
              {a.kind && mine && (
                <button
                  className="btn shrink-0 px-1.5 py-0.5 text-[9px]"
                  onClick={() => {
                    setThinking(true);
                    setPass((p) => p + 1);
                    setSelectedKind(a.kind!);
                    setMode("build");
                    setTimeout(() => setThinking(false), 420);
                  }}
                >
                  {a.kind.toUpperCase()}{a.count ? ` ×${a.count}` : ""}
                </button>
              )}
            </div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-faint">{a.detail}</p>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[9px] uppercase tracking-[0.16em] text-faint">
        <span>survey {claim ? `${(claim.profile.buildScore * 100).toFixed(0)} build` : "n/a"}</span>
        <span>·</span>
        <span>seal {lock.label}</span>
        <span>·</span>
        <span>{advice.length} orders</span>
      </div>
    </div>
  );
}

/* ------------------------------- themes ------------------------------- */

/** mini flat-map preview: three bands painted from a real palette */
function MapPreview({ palette, size = 64 }: { palette: MapPalette; size?: number }) {
  const colors = swatches(palette);
  return (
    <div className="flex overflow-hidden border border-line/70" style={{ height: size * 0.5, width: size }}>
      {[
        { c: colors.water, flex: 3 },
        { c: colors.sand, flex: 1 },
        { c: colors.land, flex: 4 },
      ].map((band) => (
        <span key={band.c} style={{ background: band.c, flex: band.flex }} />
      ))}
    </div>
  );
}

function ThemeCard({
  id,
  name,
  blurb,
  palette,
  active,
  onPick,
  children,
}: {
  id: string;
  name: string;
  blurb: string;
  palette: MapPalette;
  active: boolean;
  onPick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      aria-pressed={active}
      className={`group relative w-full cursor-pointer overflow-hidden border p-2.5 text-left transition focus:outline-none focus-visible:border-mint ${
        active ? "border-mint bg-mint/10" : "border-line/80 bg-glass/30 hover:border-dim/60"
      }`}
      data-theme-option={id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-mint" : "bg-faint/60"}`} />
            <span className="truncate text-[11.5px] text-ink">{name}</span>
          </div>
          <p className="mt-1 text-[9.5px] leading-relaxed text-dim">{blurb}</p>
        </div>
        <MapPreview palette={palette} size={52} />
      </div>
      {children}
    </div>
  );
}

/**
 * Theme picker. Four selectable looks, all glass:
 *   Dark purplish · Light purplish · Custom · Random high-contrast
 * plus the map-colour axis (true cartography vs theme-tinted ramps).
 */
export function ThemeModal() {
  const { panel, setPanel } = useWorld();
  const { themeId, theme, mapStyle, setTheme, setMapStyle, customGround, customAccent, setCustom, rerollChaos } = useTheme();
  // no local draft state: the store is the single source of truth, so the
  // pickers cannot drift from the painted theme (and no effect is needed).
  const ground = customGround;
  const accent = customAccent;
  if (panel !== "theme") return null;

  // the live, measured ratio for the theme currently painted — not a claim
  const accentRatio = contrastRatio(theme.colors.mint, theme.colors.void).toFixed(1);

  const options: { id: ThemeId; name: string; blurb: string; palette: MapPalette }[] = [
    { id: "violet", name: "Dark purplish", blurb: "Indigo glass, orchid edges — the night-shift console.", palette: BASE_THEMES.find((t) => t.id === "violet")!.map },
    { id: "lilac", name: "Light purplish", blurb: "Paper-lilac glass with plum type. Daylight readable.", palette: BASE_THEMES.find((t) => t.id === "lilac")!.map },
    { id: "custom", name: "Custom colour", blurb: "Your ground + your accent. Contrast is enforced for you.", palette: theme.id === "custom" ? theme.map : BASE_THEMES.find((t) => t.id === "custom")!.map },
    { id: "chaos", name: "Random high-contrast", blurb: "Rolled hues, verified legibility. Re-roll until it clicks.", palette: theme.id === "chaos" ? theme.map : BASE_THEMES.find((t) => t.id === "chaos")!.map },
  ];

  return (
    <Modal title="APPEARANCE · GLASS 1.0.0" onClose={() => setPanel(null)} wide>
      <div className="space-y-3 text-ink">
        <div className="grid grid-cols-2 gap-2">
          {options.map((o) => (
            <ThemeCard
              key={o.id}
              id={o.id}
              name={o.name}
              blurb={o.blurb}
              palette={o.palette}
              active={themeId === o.id}
              onPick={() => setTheme(o.id)}
            >
              {o.id === "custom" && (
                <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <label className="flex items-center gap-1 text-[9px] uppercase tracking-[0.16em] text-faint">
                    <input
                      type="color"
                      className="h-6 w-8"
                      value={ground}
                      onChange={(e) => setCustom(e.target.value, accent)}
                      aria-label="ground colour"
                    />
                    ground
                  </label>
                  <label className="flex items-center gap-1 text-[9px] uppercase tracking-[0.16em] text-faint">
                    <input
                      type="color"
                      className="h-6 w-8"
                      value={accent}
                      onChange={(e) => setCustom(ground, e.target.value)}
                      aria-label="accent colour"
                    />
                    accent
                  </label>
                </div>
              )}
              {o.id === "chaos" && (
                <span className="mt-2 inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.16em] text-faint" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <button type="button" className="btn px-1.5 py-0.5 text-[9px]" onClick={() => rerollChaos()}>
                    RE-ROLL
                  </button>
                  <span>contrast-checked</span>
                </span>
              )}
            </ThemeCard>
          ))}
        </div>

        <div className="hairline h-px" />

        <div className="flex flex-wrap items-center gap-2">
          <span className="label">map colours</span>
          <button className={`btn px-2 py-1 ${mapStyle === "cartographer" ? "btn-on" : ""}`} onClick={() => setMapStyle("cartographer")}>
            CARTOGRAPHIC
          </button>
          <button className={`btn px-2 py-1 ${mapStyle === "themed" ? "btn-on" : ""}`} onClick={() => setMapStyle("themed")}>
            THEME-TINTED
          </button>
          <span className="text-[10px] text-dim">
            cartographic keeps hue = data (blue sea, grey beach, green land); theme-tinted moves the ramps into the current look.
          </span>
        </div>

        <div className="flex items-center gap-3 border border-line/70 bg-glass/20 p-2">
          <MapPreview palette={mapStyle === "themed" ? theme.map : CARTO_PALETTE} size={120} />
          <div className="text-[10px] leading-relaxed text-dim">
            <div className="text-ink">flat map · no relief shading</div>
            <div>sea and lake → blue gradient · beach → grey gradient · mountain → green gradient</div>
            <div className="text-faint">
              accent {accentRatio}:1 on surface · generated themes are rejected below 4.5:1
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-hot px-3 py-1.5" onClick={() => setPanel(null)}>
            DONE
          </button>
          <button className="btn px-3 py-1.5" onClick={() => setTheme("cartographer")}>
            RESET TO CARTOGRAPHER
          </button>
          <span className="text-[10px] text-faint">saved per browser · applies instantly, no reload</span>
        </div>
      </div>
    </Modal>
  );
}
