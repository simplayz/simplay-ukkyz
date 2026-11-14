"use client";

import { useEffect, useRef } from "react";
import { useWorld } from "./store";
import type { EventDTO } from "@/lib/types";

/** Event types worth interrupting the pilot for. Everything else just refreshes. */
const ALERTS: Record<string, { tone: "info" | "good" | "warn" | "bad"; label: string }> = {
  assault: { tone: "bad", label: "ASSAULT" },
  relock: { tone: "good", label: "RE-SEALED" },
  claim: { tone: "info", label: "CLAIM" },
  abandon: { tone: "warn", label: "ABANDONED" },
};

/**
 * Subscribe to the pilot's notification stream.
 *
 * Deliberately additive: the 25 s poll in `page.tsx` stays as the source of
 * truth and the resync path. This only makes the *first* notification arrive in
 * about three seconds instead of up to twenty-five, and it does not fire on
 * events the pilot caused themselves a moment ago.
 *
 * `EventSource` reconnects on its own after a transport error, but it cannot
 * resume from a cursor — so we track the last id we saw and reconnect by hand
 * with `since`, falling back to the browser's own retry if that fails.
 */
export function useEventStream() {
  const pilotId = useWorld((s) => s.pilotId);
  const cursor = useRef(0);
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!pilotId) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 2_000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const since = cursor.current > 0 ? `&since=${cursor.current}` : "";
      source = new EventSource(`/api/stream?pilot=${encodeURIComponent(pilotId)}${since}`);

      source.addEventListener("ready", () => {
        backoff = 2_000;
      });

      source.addEventListener("event", (raw) => {
        const e = JSON.parse((raw as MessageEvent<string>).data) as EventDTO;
        if (seen.current.has(e.id)) return;
        seen.current.add(e.id);
        if (e.id > cursor.current) cursor.current = e.id;

        const alert = ALERTS[e.type];
        // skip the echo of something this pilot just did themselves; the
        // mutating action already raised its own toast
        const mine = useWorld.getState().pilotId === e.actorId;
        const state = useWorld.getState();
        const touchesMyParcel = state.claims.some((c) => c.id === e.claimId && c.ownerId === state.pilotId);

        if (alert && touchesMyParcel && !mine) {
          state.toast(`${alert.label} · ${e.message}`, alert.tone);
        }
        // pull the authoritative snapshot either way
        void state.refresh();
      });

      source.addEventListener("error", () => {
        source?.close();
        source = null;
        if (stopped) return;
        // EventSource would reconnect blindly and lose the cursor, so do it here
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      });
    };

    connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [pilotId]);
}
