"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorld } from "./store";
import { useTheme } from "../theme-store";
import { AdvisorAgent, AssaultReport, BuildPalette, ConfigModal, EventTicker, HelpModal, IntelModal, Minimap, OnboardModal, ParcelInspector, PilotConsole, ThemeModal, Toasts, TopBar } from "./panels";
import type { Telemetry } from "./viewport";

const WorldViewport = dynamic(() => import("./viewport").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center bg-void">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-10 w-10 animate-spin border border-mint/40 border-t-mint" />
        <div className="label">booting sector · streaming tiles · hallucinating relief</div>
      </div>
    </div>
  ),
});

export default function WorldPage() {
  const boot = useWorld((s) => s.boot);
  const mode = useWorld((s) => s.mode);
  const hover = useWorld((s) => s.hover);
  const player = useWorld((s) => s.player);
  const claims = useWorld((s) => s.claims);
  const activeClaimId = useWorld((s) => s.activeClaimId);
  const [telemetry, setTelemetry] = useState<Telemetry>({ fps: 0, draws: 0, tris: 0, tiles: "0/9", alt: 0, speed: 0 });

  useEffect(() => {
    useTheme.getState().hydrate();
    void boot();
  }, [boot]);

  useEffect(() => {
    const t = setInterval(() => {
      const s = useWorld.getState();
      if (document.visibilityState === "visible") void s.refresh();
    }, 25_000);
    return () => clearInterval(t);
  }, []);

  const activeClaim = claims.find((c) => c.id === activeClaimId);
  const tour = mode === "fps" || mode === "tps";

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-void text-ink select-none">
      <div className="absolute inset-0">
        <WorldViewport onTelemetry={setTelemetry} />
      </div>

      {/* vignette + scanlines give the viewer its instrument feel */}
      <div className="pointer-events-none absolute inset-0 z-[5] scan opacity-40" />
      <div className="pointer-events-none absolute inset-0 z-[5]" style={{ boxShadow: "inset 0 0 240px 60px rgba(0,0,0,0.75)" }} />
      {tour && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
          <div className="relative h-6 w-6">
            <span className="absolute left-1/2 top-0 h-6 w-px -translate-x-1/2 bg-mint/70" />
            <span className="absolute top-1/2 left-0 h-px w-6 -translate-y-1/2 bg-mint/70" />
            <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-mint" />
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
        <TopBar telemetry={telemetry} />

        <div className="flex min-h-0 flex-1 items-start justify-between gap-3 p-3">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <PilotConsole />
            <div className="mt-auto flex flex-col gap-3">
              <AdvisorAgent />
              <Minimap />
            </div>
          </div>

          <div className="flex h-full min-h-0 flex-col items-end gap-3">
            <BuildPalette />
            <ParcelInspector />
            {hover?.cell && activeClaim && (
              <div className="panel pointer-events-auto px-2 py-1 text-[10px] text-dim">
                cell <span className="text-mint">{hover.cell.x}</span>/<span className="text-mint">{hover.cell.y}</span> · parcel{" "}
                <span className="text-ink">{activeClaim.name}</span> {player ? "" : "· register to build"}
              </div>
            )}
          </div>
        </div>

        <EventTicker />
      </div>

      {tour && (
        <div className="panel pointer-events-auto absolute bottom-16 left-1/2 z-30 -translate-x-1/2 px-3 py-1.5 text-[10.5px] text-dim">
          <span className="text-mint">{mode === "fps" ? "FIRST PERSON" : "THIRD PERSON"}</span> · click the world to capture the mouse ·
          WASD move · SHIFT sprint · SPACE hop · ESC release
        </div>
      )}

      <ThemeModal />
      <Toasts />
      <AssaultReport />
      <OnboardModal />
      <ConfigModal />
      <IntelModal />
      <HelpModal />

      <Link
        href="/"
        className="panel absolute left-1/2 bottom-1.5 z-30 -translate-x-1/2 px-2 py-0.5 text-[9px] uppercase tracking-[0.3em] text-faint hover:text-mint"
      >
        simplayz index
      </Link>
    </main>
  );
}
