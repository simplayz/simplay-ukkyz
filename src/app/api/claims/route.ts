import { sql } from "drizzle-orm";
import { db } from "@/db";
import { claims as claimsTable, players as playersTable } from "@/db/schema";
import { createClaim, ensurePilot, findClaim, loadConfig, logEvent, newId, pilotFrom, surveyForClaim, syncClaimEconomy, claimDto, addCredits } from "@/lib/server";
import { lockCountdown, resolveAssault } from "@/engine/simulation";
import { tileForLngLat } from "@/engine/geo";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface ClaimBody {
  action: "claim" | "abandon" | "rename" | "assault" | "relock" | "jump";
  claimId?: string;
  name?: string;
  lng?: number;
  lat?: number;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as ClaimBody;
  const pilot = pilotFrom(req);
  const config = await loadConfig();
  const player = await ensurePilot(pilot);
  if (!player) return Response.json({ ok: false, error: "Register a pilot before touching the map." }, { status: 401 });

  try {
    switch (body.action) {
      case "claim": {
        if (typeof body.lng !== "number" || typeof body.lat !== "number") {
          return Response.json({ ok: false, error: "Survey coordinates missing." }, { status: 400 });
        }
        const name = (body.name ?? "").trim() || `Sector ${newId().slice(0, 4).toUpperCase()}`;
        const res = await createClaim({ playerId: player.id, lng: body.lng, lat: body.lat, name, config });
        if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: 409 });
        const row = await findClaim(res.id);
        return Response.json({ ok: true, claim: row ? await claimDto(row, config, res.survey) : null, pilotId: pilot });
      }

      case "abandon": {
        const claim = await requireOwn(body.claimId, player.id);
        if (!claim) return bad("Parcel not found or not yours.");
        await db.delete(claimsTable).where(eq(claimsTable.id, claim.id));
        await logEvent({ actorId: player.id, type: "abandon", message: `${player.handle} abandoned ${claim.name}. The grid returns to the wild.` });
        return Response.json({ ok: true });
      }

      case "rename": {
        const claim = await requireOwn(body.claimId, player.id);
        if (!claim) return bad("Parcel not found or not yours.");
        const name = (body.name ?? "").trim().slice(0, 28);
        if (!name) return bad("Name required.");
        await db.update(claimsTable).set({ name, updatedAt: new Date() }).where(eq(claimsTable.id, claim.id));
        return Response.json({ ok: true });
      }

      case "relock": {
        const claim = await requireOwn(body.claimId, player.id);
        if (!claim) return bad("Parcel not found or not yours.");
        const price = 900;
        if (player.credits < price) return bad(`Relock costs ${price} credits.`);
        await addCredits(player.id, -price, 2);
        await db
          .update(claimsTable)
          .set({ lockedUntil: new Date(Date.now() + config.lockHours * 3600_000), status: "active", updatedAt: new Date() })
          .where(eq(claimsTable.id, claim.id));
        await logEvent({ claimId: claim.id, actorId: player.id, type: "relock", message: `${player.handle} re-sealed ${claim.name} for ${config.lockHours}h.` });
        return Response.json({ ok: true });
      }

      case "assault": {
        if (!config.assaultEnabled) return bad("Assaults are disabled by the world config.");
        const claim = await findClaim(body.claimId ?? "");
        if (!claim) return bad("Target parcel missing.");
        if (claim.ownerId === player.id) return bad("You already hold this parcel.");
        const lock = lockCountdown(claim.lockedUntil ? new Date(claim.lockedUntil).toISOString() : null);
        if (!lock.open) return bad(`Parcel is sealed for ${lock.label} — assault unlocks only after the lock window.`);

        const survey = await surveyForClaim(claim, config);
        const mine = await db.select().from(claimsTable).where(eq(claimsTable.ownerId, player.id));
        const prestigeSum = mine.reduce((a, c) => a + c.prestige, 0);
        const report = resolveAssault({
          attackerCredits: player.credits,
          attackerReputation: player.reputation,
          attackerClaims: mine.length,
          attackerName: player.handle,
          defenderName: claim.name,
          defenseScore: claim.defenseScore,
          prestige: claim.prestige,
          terrainDefense: survey.profile.defenseScore,
          seed: newId().length + claim.defenseScore + player.reputation + mine.length + Math.round(claim.centerLng * 1e5),
        });

        if (report.success) {
          const id = newId();
          const tile = tileForLngLat(claim.centerLng, claim.centerLat, config.tileZoom);
          await db.update(claimsTable).set({ ownerId: player.id, lockedUntil: new Date(Date.now() + config.lockHours * 3600_000), status: "contested", tileZ: tile.z, tileX: tile.x, tileY: tile.y, updatedAt: new Date() }).where(eq(claimsTable.id, claim.id));
          await addCredits(player.id, Math.abs(report.loot), report.reputationDelta);
          await db.update(playersTable).set({ victories: sql`${playersTable.victories} + 1` }).where(eq(playersTable.id, player.id));
          if (claim.ownerId) {
            await db.update(playersTable).set({ losses: sql`${playersTable.losses} + 1`, reputation: sql`greatest(0, ${playersTable.reputation} - 8)` }).where(eq(playersTable.id, claim.ownerId));
          }
          await db.update(claimsTable).set({ prestige: sql`greatest(0, ${claimsTable.prestige} - ${Math.round(claim.prestige * 0.25)})` }).where(eq(claimsTable.id, claim.id));
          await logEvent({ claimId: claim.id, actorId: player.id, type: "assault", message: report.narrative, meta: { id, report } });
        } else {
          await addCredits(player.id, report.loot, report.reputationDelta);
          await db.update(playersTable).set({ losses: sql`${playersTable.losses} + 1` }).where(eq(playersTable.id, player.id));
          await logEvent({ claimId: claim.id, actorId: player.id, type: "assault", message: report.narrative });
        }
        await syncClaimEconomy(claim.id, config);
        const after = await findClaim(claim.id);
        return Response.json({ ok: true, report, claim: after ? await claimDto(after, config, survey) : null });
      }

      default:
        return bad(`Unknown action ${body.action}`);
    }
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "claim action failed" }, { status: 500 });
  }
}

async function requireOwn(claimId: string | undefined, playerId: string) {
  if (!claimId) return null;
  const claim = await findClaim(claimId);
  if (!claim || claim.ownerId !== playerId) return null;
  return claim;
}

function bad(message: string) {
  return Response.json({ ok: false, error: message }, { status: 400 });
}
