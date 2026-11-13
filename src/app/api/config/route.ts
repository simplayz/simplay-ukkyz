import { loadConfig, saveConfig } from "@/lib/server";
import type { WorldConfigDTO } from "@/lib/types";
import { logApiError, readApiJson, withApiLogging } from "@/lib/api-logging";

export const dynamic = "force-dynamic";

/** Live simulation tuning. Every value lands in world_config in Postgres. */
export const GET = withApiLogging("GET /api/config", async (_req: Request) => {
  return Response.json({ ok: true, config: await loadConfig() });
});

export const PATCH = withApiLogging("PATCH /api/config", async (req: Request) => {
  const body = await readApiJson<Partial<WorldConfigDTO>>(req, "PATCH /api/config", {});
  try {
    const config = await saveConfig(body);
    return Response.json({ ok: true, config });
  } catch (error) {
    logApiError("PATCH /api/config", req, error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "config update failed" }, { status: 500 });
  }
});
