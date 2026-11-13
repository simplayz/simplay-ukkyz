"use client";

import { create } from "zustand";
import type { ClaimDTO, EventDTO, LeaderRow, PlayerDTO, WorldConfigDTO, WorldSnapshot } from "@/lib/types";
import type { SurveyResult } from "@/engine/terrain";

export type Mode = "bird" | "build" | "fps" | "tps";
export type Tone = "info" | "good" | "warn" | "bad";

export interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

export interface HoverInfo {
  lng: number;
  lat: number;
  elev: number;
  slope: number;
  biome: string;
  biomeColor: string;
  cell: { x: number; y: number } | null;
  claimId: string | null;
  buildingId: string | null;
  tile: { z: number; x: number; y: number };
  source: string;
}

export const SPAWNS = [
  { name: "Berlin / Kreuzberg", lng: 13.4145, lat: 52.4989 },
  { name: "Amsterdam / Noord", lng: 4.9136, lat: 52.3957 },
  { name: "Kyoto / Arashiyama", lng: 135.671, lat: 35.017 },
  { name: "Reykjavík / harbour", lng: -21.9357, lat: 64.1509 },
  { name: "Valparaíso / hillside", lng: -71.62, lat: -33.036 },
  { name: "Cape Town / flats", lng: 18.525, lat: -33.977 },
];

const PILOT_KEY = "simplayz.pilot";

async function api<T>(path: string, init?: RequestInit & { pilot?: string | null }): Promise<{ ok: boolean; data: T | null; error?: string }> {
  const pilot = init?.pilot ?? (typeof window !== "undefined" ? localStorage.getItem(PILOT_KEY) : null);
  const headers: Record<string, string> = { "content-type": "application/json", ...(pilot ? { "x-simplayz-pilot": pilot } : {}) };
  try {
    const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
    const data = (await res.json()) as T & { ok?: boolean; error?: string };
    if (!res.ok || data?.ok === false) return { ok: false, data: null, error: data?.error ?? `engine responded ${res.status}` };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, data: null, error: error instanceof Error ? error.message : "network failure" };
  }
}

interface WorldStore {
  booted: boolean;
  busy: string | null;
  config: WorldConfigDTO;
  player: PlayerDTO | null;
  claims: ClaimDTO[];
  events: EventDTO[];
  leaderboard: LeaderRow[];
  stats: WorldSnapshot["stats"];
  pilotId: string | null;
  mode: Mode;
  center: { lng: number; lat: number };
  activeClaimId: string | null;
  selectedKind: string | null;
  rotation: number;
  tool: "build" | "demolish" | "inspect";
  hover: HoverInfo | null;
  surveyPreview: SurveyResult | null;
  surveyBusy: boolean;
  toasts: Toast[];
  panel: null | "onboard" | "config" | "intel" | "help" | "theme";
  lastReport: Record<string, unknown> | null;
  timeOfDay: number;

  boot: () => Promise<void>;
  refresh: () => Promise<void>;
  register: (handle: string, home?: { lng: number; lat: number }) => Promise<void>;
  setMode: (m: Mode) => void;
  setCenter: (lng: number, lat: number) => void;
  setActiveClaim: (id: string | null) => void;
  setSelectedKind: (k: string | null) => void;
  setTool: (t: WorldStore["tool"]) => void;
  rotate: () => void;
  setHover: (h: HoverInfo | null) => void;
  setPanel: (p: WorldStore["panel"]) => void;
  setTimeOfDay: (v: number) => void;
  toast: (text: string, tone?: Tone) => void;
  previewSurvey: (lng: number, lat: number) => Promise<void>;
  claimAt: (lng: number, lat: number, name: string) => Promise<boolean>;
  abandonClaim: (id: string) => Promise<void>;
  renameClaim: (id: string, name: string) => Promise<void>;
  relockClaim: (id: string) => Promise<void>;
  assaultClaim: (id: string) => Promise<void>;
  placeBuilding: (claimId: string, kind: string, cellX: number, cellY: number, rot: number) => Promise<void>;
  demolish: (claimId: string, buildingId: string) => Promise<void>;
  upgrade: (claimId: string, buildingId: string) => Promise<void>;
  saveConfig: (patch: Partial<WorldConfigDTO>) => Promise<void>;
  relocate: (lng: number, lat: number) => Promise<void>;
}

const FALLBACK_CONFIG: WorldConfigDTO = {
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

let toastSeq = 1;

export const useWorld = create<WorldStore>((set, get) => ({
  booted: false,
  busy: null,
  config: FALLBACK_CONFIG,
  player: null,
  claims: [],
  events: [],
  leaderboard: [],
  stats: { players: 0, claims: 0, structures: 0, tilesCached: 0, tilesServed: 0, surveys: 0 },
  pilotId: null,
  mode: "bird",
  center: { lng: SPAWNS[0].lng, lat: SPAWNS[0].lat },
  activeClaimId: null,
  selectedKind: null,
  rotation: 0,
  tool: "build",
  hover: null,
  surveyPreview: null,
  surveyBusy: false,
  toasts: [],
  panel: null,
  lastReport: null,
  timeOfDay: 17.5,

  toast: (text, tone = "info") => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5200);
  },

  boot: async () => {
    const pilotId = typeof window !== "undefined" ? localStorage.getItem(PILOT_KEY) : null;
    const res = await api<WorldSnapshot>("/api/world", { pilot: pilotId });
    if (res.ok && res.data) {
      const snap = res.data;
      set({
        booted: true,
        pilotId,
        config: snap.config,
        player: snap.player,
        claims: snap.claims,
        events: snap.events,
        leaderboard: snap.leaderboard,
        stats: snap.stats,
        center: snap.player ? { lng: snap.player.homeLng, lat: snap.player.homeLat } : get().center,
        activeClaimId: snap.claims.find((c) => c.ownerId === snap.player?.id)?.id ?? null,
        panel: snap.player ? get().panel : "onboard",
      });
      return;
    }
    set({ booted: true, panel: get().player ? get().panel : "onboard" });
    get().toast(res.error ?? "world snapshot unavailable — running on cached defaults", "warn");
  },

  refresh: async () => {
    const res = await api<WorldSnapshot>("/api/world");
    if (res.ok && res.data) {
      const snap = res.data;
      set({ config: snap.config, player: snap.player, claims: snap.claims, events: snap.events, leaderboard: snap.leaderboard, stats: snap.stats });
    }
  },

  register: async (handle, home) => {
    set({ busy: "pilot" });
    const res = await api<{ pilotId: string; player: PlayerDTO }>("/api/player", {
      method: "POST",
      pilot: localStorage.getItem(PILOT_KEY),
      body: JSON.stringify({ handle, homeLng: home?.lng, homeLat: home?.lat }),
    });
    set({ busy: null });
    if (!res.ok || !res.data) {
      get().toast(res.error ?? "pilot registration failed", "bad");
      return;
    }
    localStorage.setItem(PILOT_KEY, res.data.pilotId);
    set({ pilotId: res.data.pilotId, player: res.data.player, panel: null, center: home ?? get().center });
    get().toast(`pilot ${res.data.player?.handle ?? handle} online`, "good");
    await get().refresh();
  },

  setMode: (m) => set({ mode: m }),
  setCenter: (lng, lat) => set({ center: { lng, lat } }),
  setActiveClaim: (id) => set({ activeClaimId: id, selectedKind: null, tool: "build" }),
  setSelectedKind: (k) => set({ selectedKind: k, mode: k ? "build" : get().mode === "build" ? "bird" : get().mode, tool: "build" }),
  setTool: (t) => set({ tool: t, mode: "build" }),
  rotate: () => set((s) => ({ rotation: (s.rotation + 1) % 4 })),
  setHover: (h) => set({ hover: h }),
  setPanel: (p) => set({ panel: p }),
  setTimeOfDay: (v) => set({ timeOfDay: v }),

  previewSurvey: async (lng, lat) => {
    if (get().surveyBusy) return;
    set({ surveyBusy: true });
    const res = await api<{ ok: boolean; survey: SurveyResult; cached: boolean; ms: number }>(`/api/terrain?lng=${lng}&lat=${lat}`);
    set({ surveyBusy: false });
    if (res.ok && res.data) {
      set({ surveyPreview: res.data.survey });
      get().toast(`terrain engine: survey in ${res.data.ms}ms (${res.data.cached ? "cache" : "generated"})`, "info");
    } else {
      get().toast(res.error ?? "survey failed", "warn");
    }
  },

  claimAt: async (lng, lat, name) => {
    set({ busy: "claim" });
    const res = await api<{ claim: ClaimDTO }>("/api/claims", {
      method: "POST",
      body: JSON.stringify({ action: "claim", lng, lat, name }),
    });
    set({ busy: null });
    if (!res.ok || !res.data?.claim) {
      get().toast(res.error ?? "claim rejected", "bad");
      return false;
    }
    const claim = res.data.claim;
    set((s) => ({ claims: [claim, ...s.claims.filter((c) => c.id !== claim.id)], activeClaimId: claim.id, panel: null, surveyPreview: null, mode: "build" }));
    get().toast(`parcel ${claim.name} locked for ${get().config.lockHours}h`, "good");
    await get().refresh();
    return true;
  },

  abandonClaim: async (id) => {
    const res = await api("/api/claims", { method: "POST", body: JSON.stringify({ action: "abandon", claimId: id }) });
    if (!res.ok) return get().toast(res.error ?? "abandon failed", "bad");
    set((s) => ({ claims: s.claims.filter((c) => c.id !== id), activeClaimId: s.activeClaimId === id ? null : s.activeClaimId }));
    get().toast("parcel released to the wild", "warn");
    await get().refresh();
  },

  renameClaim: async (id, name) => {
    const res = await api("/api/claims", { method: "POST", body: JSON.stringify({ action: "rename", claimId: id, name }) });
    if (!res.ok) return get().toast(res.error ?? "rename failed", "bad");
    await get().refresh();
  },

  relockClaim: async (id) => {
    const res = await api("/api/claims", { method: "POST", body: JSON.stringify({ action: "relock", claimId: id }) });
    if (!res.ok) return get().toast(res.error ?? "relock failed", "bad");
    get().toast("seal extended", "good");
    await get().refresh();
  },

  assaultClaim: async (id) => {
    set({ busy: "assault" });
    const res = await api<{ report: Record<string, unknown>; claim: ClaimDTO }>("/api/claims", {
      method: "POST",
      body: JSON.stringify({ action: "assault", claimId: id }),
    });
    set({ busy: null });
    if (!res.ok) return get().toast(res.error ?? "assault rejected", "bad");
    set({ lastReport: res.data?.report ?? null });
    get().toast(res.data?.report && (res.data.report as { success?: boolean }).success ? "parcel seized — sovereignty updated" : "assault repelled", res.data?.report && (res.data.report as { success?: boolean }).success ? "good" : "bad");
    await get().refresh();
  },

  placeBuilding: async (claimId, kind, cellX, cellY, rot) => {
    const res = await api<{ claim: ClaimDTO }>("/api/buildings", {
      method: "POST",
      body: JSON.stringify({ action: "place", claimId, kind, cellX, cellY, rot }),
    });
    if (!res.ok) {
      get().toast(res.error ?? "placement rejected", "bad");
      return;
    }
    if (res.data?.claim) set((s) => ({ claims: s.claims.map((c) => (c.id === claimId ? res.data!.claim : c)) }));
    await get().refresh();
  },

  demolish: async (claimId, buildingId) => {
    const res = await api("/api/buildings", { method: "POST", body: JSON.stringify({ action: "demolish", claimId, buildingId }) });
    if (!res.ok) return get().toast(res.error ?? "demolition failed", "bad");
    get().toast("structure salvaged (+35% credits)", "warn");
    await get().refresh();
  },

  upgrade: async (claimId, buildingId) => {
    const res = await api("/api/buildings", { method: "POST", body: JSON.stringify({ action: "upgrade", claimId, buildingId }) });
    if (!res.ok) return get().toast(res.error ?? "upgrade failed", "bad");
    get().toast("structure tier increased", "good");
    await get().refresh();
  },

  saveConfig: async (patch) => {
    set({ busy: "config" });
    const res = await api<{ config: WorldConfigDTO }>("/api/config", { method: "PATCH", body: JSON.stringify(patch) });
    set({ busy: null });
    if (!res.ok || !res.data) return get().toast(res.error ?? "config write failed", "bad");
    set({ config: res.data.config });
    get().toast("world_config updated in postgres", "good");
    await get().refresh();
  },

  relocate: async (lng, lat) => {
    set({ center: { lng, lat } });
    const res = await api("/api/player", { method: "POST", body: JSON.stringify({ homeLng: lng, homeLat: lat }) });
    if (!res.ok) return;
    get().toast(`pilot beacon moved to ${lat.toFixed(4)}, ${lng.toFixed(4)}`, "info");
    await get().refresh();
  },
}));

export function myClaims(claims: ClaimDTO[], playerId: string | null) {
  return claims.filter((c) => c.ownerId === playerId);
}
