import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { buildings as buildingsTable } from "@/db/schema";
import { KIND_MAP, upgradeCost } from "@/engine/buildings";
import { checkPlacement } from "@/engine/simulation";
import { addCredits, claimBuildings, claimDto, ensurePilot, findClaim, loadConfig, logEvent, newId, pilotFrom, spendCredits, surveyForClaim, syncClaimEconomy } from "@/lib/server";

export const dynamic = "force-dynamic";

interface Body {
  action: "place" | "demolish" | "upgrade" | "repair";
  claimId?: string;
  buildingId?: string;
  kind?: string;
  cellX?: number;
  cellY?: number;
  rot?: number;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const pilot = pilotFrom(req);
  const config = await loadConfig();
  const player = await ensurePilot(pilot);
  if (!player) return Response.json({ ok: false, error: "Register a pilot first." }, { status: 401 });

  const claim = await findClaim(body.claimId ?? "");
  if (!claim) return Response.json({ ok: false, error: "Parcel missing." }, { status: 404 });
  if (claim.ownerId !== player.id) return Response.json({ ok: false, error: "You do not hold this parcel." }, { status: 403 });

  const survey = await surveyForClaim(claim, config);
  const existing = await claimBuildings(claim.id);

  try {
    if (body.action === "place") {
      const kind = body.kind ? KIND_MAP[body.kind] : undefined;
      if (!kind) return Response.json({ ok: false, error: "Unknown structure key." }, { status: 400 });
      const check = checkPlacement(kind, body.cellX ?? -1, body.cellY ?? -1, body.rot ?? 0, config.gridCells, existing, survey, player.credits);
      if (!check.ok) return Response.json({ ok: false, error: check.reason ?? "Placement rejected." }, { status: 409 });
      const id = newId();
      await db.insert(buildingsTable).values({
        id,
        claimId: claim.id,
        kind: kind.key,
        cellX: body.cellX ?? 0,
        cellY: body.cellY ?? 0,
        rot: body.rot ?? 0,
        level: 1,
      });
      await spendCredits(player.id, check.cost ?? kind.cost);
      await syncClaimEconomy(claim.id, config);
      await logEvent({ claimId: claim.id, actorId: player.id, type: "build", message: `${kind.name} raised on ${claim.name} for ${check.cost} cr.` });
      const after = await findClaim(claim.id);
      return Response.json({ ok: true, buildingId: id, cost: check.cost, claim: after ? await claimDto(after, config, survey) : null, player: await ensurePilot(pilot) });
    }

    if (body.action === "demolish") {
      const target = await db.select().from(buildingsTable).where(eq(buildingsTable.id, body.buildingId ?? "")).limit(1);
      if (!target.length) return Response.json({ ok: false, error: "Structure missing." }, { status: 404 });
      await db.delete(buildingsTable).where(eq(buildingsTable.id, target[0].id));
      const kind = KIND_MAP[target[0].kind];
      if (kind) await addCredits(player.id, Math.round(kind.cost * 0.35 * target[0].level));
      await syncClaimEconomy(claim.id, config);
      const after = await findClaim(claim.id);
      return Response.json({ ok: true, claim: after ? await claimDto(after, config, survey) : null, player: await ensurePilot(pilot) });
    }

    if (body.action === "upgrade") {
      const target = await db.select().from(buildingsTable).where(eq(buildingsTable.id, body.buildingId ?? "")).limit(1);
      if (!target.length) return Response.json({ ok: false, error: "Structure missing." }, { status: 404 });
      const kind = KIND_MAP[target[0].kind];
      if (!kind) return Response.json({ ok: false, error: "Unknown structure kind." }, { status: 400 });
      const maxLevel = 5;
      if (target[0].level >= maxLevel) return Response.json({ ok: false, error: "Maximum tier reached (V)." }, { status: 409 });
      const cost = upgradeCost(kind, target[0].level);
      if (player.credits < cost) return Response.json({ ok: false, error: `Upgrade needs ${cost} cr.` }, { status: 409 });
      await db.update(buildingsTable).set({ level: sql`${buildingsTable.level} + 1`, integrity: 100 }).where(eq(buildingsTable.id, target[0].id));
      await spendCredits(player.id, cost);
      await syncClaimEconomy(claim.id, config);
      await logEvent({ claimId: claim.id, actorId: player.id, type: "upgrade", message: `${kind.name} upgraded to tier ${target[0].level + 1} on ${claim.name} (${cost} cr).` });
      const after = await findClaim(claim.id);
      return Response.json({ ok: true, claim: after ? await claimDto(after, config, survey) : null, player: await ensurePilot(pilot) });
    }

    if (body.action === "repair") {
      await db.update(buildingsTable).set({ integrity: 100 }).where(eq(buildingsTable.claimId, claim.id));
      await spendCredits(player.id, 400);
      await syncClaimEconomy(claim.id, config);
      const after = await findClaim(claim.id);
      return Response.json({ ok: true, claim: after ? await claimDto(after, config, survey) : null });
    }

    return Response.json({ ok: false, error: `Unknown action ${body.action}` }, { status: 400 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "build action failed" }, { status: 500 });
  }
}
