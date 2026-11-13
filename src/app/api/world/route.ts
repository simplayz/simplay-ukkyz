import { pilotFrom, snapshot } from "@/lib/server";
import { logApiError, withApiLogging } from "@/lib/api-logging";

export const dynamic = "force-dynamic";

/** Full world snapshot: config + pilot + every parcel + engine telemetry. */
export const GET = withApiLogging("GET /api/world", async (req: Request) => {
  const pilot = pilotFrom(req);
  try {
    return Response.json(await snapshot(pilot));
  } catch (error) {
    logApiError("GET /api/world", req, error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "snapshot failed" }, { status: 500 });
  }
});
