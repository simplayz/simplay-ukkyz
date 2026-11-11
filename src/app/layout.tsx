import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Simplayz — sector OS for a procedurally hallucinated world",
  description:
    "Simplayz streams OpenStreetMap raster at zoom 15, re-imagines the terrain with a procedural engine, and lets pilots lock, build and contest 1 km² parcels in a bird's-eye world simulation.",
};

export const viewport: Viewport = {
  themeColor: "#04070a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-void text-slate-200 antialiased">{children}</body>
    </html>
  );
}
