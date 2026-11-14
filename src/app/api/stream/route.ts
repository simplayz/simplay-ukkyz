import { eventsForPilot, latestEventId } from "@/lib/server";

/**
 * Live notification stream for one pilot.
 *
 * Server-Sent Events rather than a socket: the payload is one-directional
 * (server -> browser), it survives proxies as plain HTTP, and a route handler
 * can hold the response open with a ReadableStream.
 *
 * The stream is a *notification* channel, not a source of truth. It emits event
 * rows that concern the pilot, and the client still calls refresh() on receipt
 * to pull the authoritative snapshot. A dropped stream therefore degrades to the
 * existing polling behaviour rather than freezing the world.
 *
 * Events match on claimId (parcels you own) or actorId (things you did), so a
 * busy world cannot push your own assault notice out of the feed.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const POLL_MS = 3_000;
/** comments keep proxies and browsers from timing the connection out */
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pilotId = url.searchParams.get("pilot");
  if (!pilotId) {
    return Response.json({ ok: false, error: "pilot id required" }, { status: 400 });
  }

  // Resume where the client left off, or from "now" on a cold start so a
  // reconnect does not replay the whole world's history.
  const sinceParam = Number(url.searchParams.get("since"));
  let cursor = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : await latestEventId();

  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          stop();
        }
      };

      send("ready", { cursor, pollMs: POLL_MS });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          stop();
        }
      }, HEARTBEAT_MS);

      const tick = async () => {
        if (closed) return;
        try {
          const events = await eventsForPilot(pilotId, cursor);
          if (events.length) {
            cursor = events[events.length - 1].id;
            for (const e of events) send("event", e);
          }
        } catch {
          send("error", { message: "event poll failed" });
        }
        if (!closed) timer = setTimeout(tick, POLL_MS);
      };

      void tick();

      req.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx and friends buffer SSE into uselessness without this
      "x-accel-buffering": "no",
    },
  });
}
