import { db } from "@/db";
import { sql } from "drizzle-orm";
import { logApiError, withApiLogging } from "@/lib/api-logging";

export const dynamic = "force-dynamic";

export const GET = withApiLogging("GET /api/health", async (req: Request) => {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (error) {
    logApiError("GET /api/health", req, error);
    return Response.json({ ok: false }, { status: 500 });
  }
});
