import { loadConfig, saveConfig } from "@/lib/server";
import type { WorldConfigDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Live simulation tuning. Every value lands in world_config in Postgres. */
export async function GET() {
  return Response.json({ ok: true, config: await loadConfig() });
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<WorldConfigDTO>;
  try {
    const config = await saveConfig(body);
    return Response.json({ ok: true, config });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "config update failed" }, { status: 500 });
  }
}
