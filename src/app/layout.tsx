import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Simplayz 1.0.0 — a persistent, browser-based sector simulation",
  description:
    "Simplayz is a persistent, browser-based sector simulation. A seeded terrain engine re-imagines the surface as a flat cartographic map and lets pilots lock, build and contest 1 km² parcels in a bird's-eye world.",
};

export const viewport: Viewport = {
  themeColor: "#04070a",
  colorScheme: "dark",
};

/**
 * Pre-hydration theme boot. The store persists the *resolved* custom
 * properties of the active theme (see src/lib/theme.ts), so this script
 * can repaint <html> before the bundle loads — no dark flash for a lilac
 * pilot, and no duplicated colour logic here.
 */
const THEME_BOOT = `
(function(){
  try {
    var raw = localStorage.getItem("simplayz.theme.v1");
    if (!raw) return;
    var st = JSON.parse(raw) || {};
    var root = document.documentElement;
    var tokens = st.tokens || {};
    for (var k in tokens) root.style.setProperty(k, tokens[k]);
    if (st.themeId) root.dataset.theme = st.themeId;
    if (st.mapStyle) root.dataset.map = st.mapStyle;
    if (tokens["--sim-scheme"]) { root.dataset.scheme = tokens["--sim-scheme"]; root.style.colorScheme = tokens["--sim-scheme"]; }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="bg-void text-ink antialiased">{children}</body>
    </html>
  );
}
