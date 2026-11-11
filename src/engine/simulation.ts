/* ------------------------------------------------------------------ *
 * Simplayz simulation kernel — pure functions shared by the API
 * (authoritative) and the client (optimistic prediction).
 * ------------------------------------------------------------------ */

import { BIOMES, type SurveyResult } from "@/engine/terrain";
import { KIND_MAP, effectiveHeight, footprintFor, type BuildKind } from "@/engine/buildings";
import type { BuildingDTO } from "@/lib/types";

export interface ClaimTotals {
  structures: number;
  occupied: number;
  population: number;
  income: number;
  upkeep: number;
  netIncome: number;
  food: number;
  power: number;
  defense: number;
  prestige: number;
  disconnected: string[];
}

export function footprintCells(kind: BuildKind, x: number, y: number, rot: number, cells: number) {
  const [w, d] = footprintFor(kind, rot);
  const out: { x: number; y: number }[] = [];
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const cx = x + i;
      const cy = y + j;
      if (cx < 0 || cy < 0 || cx >= cells || cy >= cells) return null;
      out.push({ x: cx, y: cy });
    }
  }
  return out;
}

export function occupancy(buildings: BuildingDTO[], cells: number) {
  const map = new Map<number, string>();
  for (const b of buildings) {
    const kind = KIND_MAP[b.kind];
    if (!kind) continue;
    const spans = footprintCells(kind, b.cellX, b.cellY, b.rot, cells);
    if (!spans) continue;
    for (const s of spans) map.set(s.y * cells + s.x, b.id);
  }
  return map;
}

export interface PlaceCheck {
  ok: boolean;
  reason?: string;
  costMod?: number;
  cost?: number;
}

export function checkPlacement(
  kind: BuildKind,
  x: number,
  y: number,
  rot: number,
  cells: number,
  buildings: BuildingDTO[],
  survey: SurveyResult | null,
  credits: number,
): PlaceCheck {
  const spans = footprintCells(kind, x, y, rot, cells);
  if (!spans) return { ok: false, reason: "Footprint crosses the survey boundary" };
  const occ = occupancy(buildings, cells);
  for (const s of spans) {
    if (occ.has(s.y * cells + s.x)) return { ok: false, reason: "Cell already occupied by a structure" };
  }
  let costMod = 1;
  let worstSlope = false;
  if (survey) {
    for (const s of spans) {
      const c = survey.grid[s.y * cells + s.x];
      if (!c) continue;
      if (c.ok === 0) return { ok: false, reason: `Unsupported ground: ${BIOMES[c.b]?.name ?? "water"}` };
      if (c.ok === 2) worstSlope = true;
      const bmod = BIOMES[c.b]?.costMod ?? 1;
      costMod = Math.max(costMod, bmod);
    }
  }
  if (worstSlope) costMod *= 1.6;
  if (kind.minFarm !== undefined && survey && survey.profile.farmScore < kind.minFarm) {
    return { ok: false, reason: `Soil survey too poor (needs farm score ≥ ${kind.minFarm.toFixed(2)})` };
  }
  const cost = Math.round(kind.cost * costMod);
  if (cost > credits) return { ok: false, reason: `Insufficient credits (${cost} required)`, cost, costMod };
  return { ok: true, cost, costMod };
}

export function hasRoadAccess(buildings: BuildingDTO[], kind: BuildKind, x: number, y: number, rot: number, cells: number) {
  const spans = footprintCells(kind, x, y, rot, cells);
  if (!spans) return false;
  const roads = buildings.filter((b) => b.kind === "road" || b.kind === "junction");
  const set = new Set(spans.map((s) => `${s.x},${s.y}`));
  for (const r of roads) {
    const rk = KIND_MAP[r.kind];
    if (!rk) continue;
    const rs = footprintCells(rk, r.cellX, r.cellY, r.rot, cells);
    if (!rs) continue;
    for (const s of rs) {
      for (const own of spans) {
        if (Math.abs(s.x - own.x) + Math.abs(s.y - own.y) <= 1) return true;
      }
    }
    if (set.size && rs.some((s) => set.has(`${s.x},${s.y}`))) return true;
  }
  return buildings.some((b) => b.kind === "junction");
}

export function computeTotals(buildings: BuildingDTO[], survey: SurveyResult | null, cells: number): ClaimTotals {
  const totals: ClaimTotals = {
    structures: buildings.length,
    occupied: 0,
    population: 0,
    income: 0,
    upkeep: 0,
    netIncome: 0,
    food: 0,
    power: 0,
    defense: 0,
    prestige: 0,
    disconnected: [],
  };
  const occ = occupancy(buildings, cells);
  totals.occupied = occ.size;
  const junctions = buildings.filter((b) => b.kind === "junction").length;
  const connectivity = 1 + Math.min(0.35, junctions * 0.07);

  for (const b of buildings) {
    const kind = KIND_MAP[b.kind];
    if (!kind) continue;
    const lvl = Math.max(1, b.level);
    const scale = 1 + (lvl - 1) * 0.55;
    const integrity = Math.max(0.15, (b.integrity ?? 100) / 100);
    let served = true;
    if (kind.needsRoad && !hasRoadAccess(buildings, kind, b.cellX, b.cellY, b.rot, cells)) {
      served = false;
      totals.disconnected.push(kind.name);
    }
    const eff = (served ? 1 : 0.35) * scale * integrity;

    const spans = footprintCells(kind, b.cellX, b.cellY, b.rot, cells) ?? [];
    let soil = 1;
    let cover = 1;
    for (const s of spans) {
      const c = survey?.grid[s.y * cells + s.x];
      if (!c) continue;
      const bio = BIOMES[c.b];
      soil = Math.max(soil, 0.4 + bio.fertility * 0.8);
      cover = Math.max(cover, bio.cover);
    }

    totals.population += Math.round(kind.population * eff * (served ? 1 : 0.6));
    totals.income += kind.income * eff * connectivity * (kind.category === "food" ? soil : 1);
    totals.upkeep += kind.upkeep * scale;
    totals.food += kind.food * eff * soil;
    totals.power += kind.power * (kind.power > 0 ? scale : 1);
    totals.defense += kind.defense * scale * cover * integrity;
    totals.prestige += kind.prestige * scale;
  }

  const terrainDefense = survey ? survey.profile.defenseScore : 1;
  totals.defense = Math.round((totals.defense * 10 + 40) * (0.75 + terrainDefense * 0.22));
  totals.income = Math.round(totals.income);
  totals.upkeep = Math.round(totals.upkeep);
  totals.netIncome = Math.max(-60, Math.round(totals.income - totals.upkeep));
  totals.food = Math.round(totals.food);
  totals.power = Math.round(totals.power);
  totals.prestige = Math.round(totals.prestige);
  totals.disconnected = Array.from(new Set(totals.disconnected));
  return totals;
}

/** Average ground height of a footprint, for mesh placement. */
export function footprintGroundHeight(kind: BuildKind, x: number, y: number, rot: number, cells: number, survey: SurveyResult | null) {
  if (!survey) return 0;
  const spans = footprintCells(kind, x, y, rot, cells) ?? [];
  if (spans.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const s of spans) {
    const c = survey.grid[s.y * cells + s.x];
    if (c) {
      sum += c.y;
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function structureVisualHeight(kind: BuildKind, level: number) {
  return effectiveHeight(kind, level);
}

/* ----------------------------- combat ----------------------------- */

export interface AssaultInput {
  attackerCredits: number;
  attackerReputation: number;
  attackerClaims: number;
  defenderName: string;
  attackerName: string;
  defenseScore: number;
  prestige: number;
  terrainDefense: number;
  seed: number;
}

export interface AssaultReport {
  ok: boolean;
  success: boolean;
  attackerPower: number;
  defenderPower: number;
  margin: number;
  loot: number;
  reputationDelta: number;
  narrative: string;
  phases: { name: string; roll: number; note: string }[];
}

/**
 * Four-phase resolution: recon, breach, hold, flag. Deterministic from the
 * seed so a report can be replayed and audited, which is the whole point of
 * running the conflict layer on the server.
 */
export function resolveAssault(input: AssaultInput): AssaultReport {
  const mobilisation = Math.min(0.85, Math.max(0.12, input.attackerCredits / 9000));
  const momentum = 1 + Math.min(0.6, input.attackerReputation / 420);
  const roll = (n: number) => frac(Math.sin(input.seed * 12.9898 + n * 78.233) * 43758.5453);
  const phases = [
    { name: "RECON", roll: roll(1), note: "drone sweep of the perimeter" },
    { name: "BREACH", roll: roll(2), note: "counter against terrain-anchored defense" },
    { name: "HOLD", roll: roll(3), note: "supply line endurance" },
    { name: "FLAG", roll: roll(4), note: "sovereignty upload to the ledger" },
  ];

  const attackerPower = Math.round(60 + mobilisation * 240 * momentum + phases[0].roll * 70);
  const defenderPower = Math.round(input.defenseScore * (0.85 + phases[1].roll * 0.4) * (0.8 + input.terrainDefense * 0.25) + 30);
  const holdScore = phases[2].roll * (attackerPower - defenderPower) + (input.attackerClaims < 3 ? 24 : 0);
  const flagScore = phases[3].roll * 100;
  const margin = attackerPower - defenderPower + holdScore * 0.35 + flagScore * 0.15;
  const success = margin > 0;

  const loot = success ? Math.round(Math.min(input.attackerCredits * 0.4, 400 + input.prestige * 26 + defenderPower * 1.6)) : -Math.round(Math.min(input.attackerCredits * 0.18, 220 + attackerPower * 0.3));
  const reputationDelta = success ? Math.round(18 + input.prestige * 0.6) : -Math.round(9 + defenderPower / 40);

  const narrative = success
    ? `${input.attackerName} pushed through the ${phases[1].roll > 0.5 ? "north berm" : "creek line"}, absorbed ${Math.max(0, Math.round(defenderPower * 0.34))} points of resistance and uploaded a new sovereignty record for ${input.defenderName}.`
    : `${input.attackerName} stalled at the breach phase of ${input.defenderName}: ${defenderPower} defensive points anchored on terrain modifier ${input.terrainDefense.toFixed(2)}. The lock stands.`;

  return {
    ok: true,
    success,
    attackerPower,
    defenderPower,
    margin: Math.round(margin),
    loot,
    reputationDelta,
    narrative,
    phases,
  };
}

function frac(v: number) {
  return v - Math.floor(v);
}

export function lockCountdown(lockedUntil: string | null, now = Date.now()) {
  if (!lockedUntil) return { remaining: 0, open: true, label: "OPEN" };
  const remaining = new Date(lockedUntil).getTime() - now;
  if (remaining <= 0) return { remaining: 0, open: true, label: "OPEN" };
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return { remaining, open: false, label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` };
}
