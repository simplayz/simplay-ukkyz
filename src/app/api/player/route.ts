import { db } from "@/db";
import { players as playersTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import { ensurePilot, loadConfig, logEvent, movePlayer, pilotFrom } from "@/lib/server";
import { logApiError, readApiJson, withApiLogging } from "@/lib/api-logging";

export const dynamic = "force-dynamic";

const PALETTE = ["#7df0c0", "#ffb454", "#68b7ff", "#f47ba8", "#c5a3ff", "#9ae66e", "#ff8f6b", "#63e0e8"];

function handleFrom(seed: string) {
  const h = createHash("sha1").update(seed).digest("hex");
  const pre = ["kite", "delta", "meridian", "basalt", "orchid", "vector", "cobalt", "sable", "quartz", "harbor"];
  const suf = ["fox", "drone", "surveyor", "mason", "nomad", "atlas", "pilgrim", "warden", "smith", "lark"];
  const a = parseInt(h.slice(0, 4), 16);
  const b = parseInt(h.slice(4, 8), 16);
  return `${pre[a % pre.length]}-${suf[b % suf.length]}-${h.slice(8, 11).toUpperCase()}`;
}

/** Register / update the local pilot identity (no passwords: a bearer id only). */
export const POST = withApiLogging("POST /api/player", async (req: Request) => {
  const body = await readApiJson(req, "POST /api/player", {} as {
    handle?: string;
    homeLng?: number;
    homeLat?: number;
    color?: string;
    adopt?: string;
  });
  let pilot = pilotFrom(req);
  const config = await loadConfig();
  try {
    if (!pilot) {
      pilot = randomUUID();
      const handle = (body.handle ?? handleFrom(pilot)).toString().trim().slice(0, 24);
      const color = body.color ?? PALETTE[Math.abs(hashStr(pilot)) % PALETTE.length];
      await db
        .insert(playersTable)
        .values({
          id: pilot,
          handle,
          color,
          credits: config.startCredits,
          homeLng: typeof body.homeLng === "number" ? body.homeLng : 13.405,
          homeLat: typeof body.homeLat === "number" ? body.homeLat : 52.52,
        })
        .onConflictDoNothing();
      await logEvent({ actorId: pilot, type: "pilot", message: `Pilot ${handle} authenticated into the simulation.` });
    }
    const player = await ensurePilot(pilot, {
      handle: body.handle,
      homeLng: body.homeLng,
      homeLat: body.homeLat,
      color: body.color,
    });
    if (typeof body.homeLng === "number" && typeof body.homeLat === "number") {
      await movePlayer(pilot, { homeLng: body.homeLng, homeLat: body.homeLat });
    }
    return Response.json({ ok: true, pilotId: pilot, player });
  } catch (error) {
    logApiError("POST /api/player", req, error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "pilot failed" }, { status: 500 });
  }
});

export const GET = withApiLogging("GET /api/player", async (req: Request) => {
  const pilot = pilotFrom(req);
  const player = await ensurePilot(pilot);
  return Response.json({ ok: true, pilotId: pilot, player });
});

function hashStr(s: string) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
  return n;
}
