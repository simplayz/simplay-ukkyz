import type { SurveyProfile } from "@/engine/terrain";

export interface WorldConfigDTO {
  claimSizeM: number;
  gridCells: number;
  lockHours: number;
  maxClaims: number;
  tileZoom: number;
  tileSource: string;
  tileTtlHours: number;
  terrainCacheSeconds: number;
  terrainSeed: number;
  reliefScale: number;
  tickMinutes: number;
  startCredits: number;
  assaultEnabled: boolean;
}

export interface PlayerDTO {
  id: string;
  handle: string;
  color: string;
  credits: number;
  reputation: number;
  victories: number;
  losses: number;
  homeLng: number;
  homeLat: number;
}

export interface BuildingDTO {
  id: string;
  kind: string;
  cellX: number;
  cellY: number;
  rot: number;
  level: number;
  integrity: number;
}

export interface ClaimDTO {
  id: string;
  name: string;
  ownerId: string | null;
  owner: { handle: string; color: string; reputation: number } | null;
  centerLng: number;
  centerLat: number;
  tileZ: number;
  tileX: number;
  tileY: number;
  sizeM: number;
  status: string;
  lockedUntil: string | null;
  defenseScore: number;
  prestige: number;
  income: number;
  population: number;
  profile: SurveyProfile;
  buildings: BuildingDTO[];
  createdAt: string;
}

export interface EventDTO {
  id: number;
  type: string;
  message: string;
  claimId: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface LeaderRow {
  id: string;
  handle: string;
  color: string;
  credits: number;
  reputation: number;
  victories: number;
  losses: number;
  claims: number;
  max?: number;
}

export interface WorldSnapshot {
  config: WorldConfigDTO;
  player: PlayerDTO | null;
  claims: ClaimDTO[];
  events: EventDTO[];
  leaderboard: LeaderRow[];
  stats: { players: number; claims: number; structures: number; tilesCached: number; tilesServed: number; surveys: number };
  serverTime: string;
  engine: { name: string; build: string; model: string };
}

export interface PlaceRequest {
  claimId: string;
  kind: string;
  cellX: number;
  cellY: number;
  rot: number;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  claim?: ClaimDTO;
  claims?: ClaimDTO[];
  report?: Record<string, unknown>;
  player?: PlayerDTO;
}
