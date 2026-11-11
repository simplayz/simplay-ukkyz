import { pilotFrom, snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Full world snapshot: config + pilot + every parcel + engine telemetry. */
export async function GET(req: Request) {
  const pilot = pilotFrom(req);
  try {
    return Response.json(await snapshot(pilot));
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "snapshot failed" }, { status: 500 });
  }
}
