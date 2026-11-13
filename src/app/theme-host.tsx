"use client";

/* ------------------------------------------------------------------ *
 * THEME HOST
 * The landing page is a server component (it reads the ledger straight
 * from Postgres), but the theme has to be applied in the browser. This
 * tiny client leaf hydrates the theme store once per mount and renders
 * its children untouched, so no layout is duplicated.
 * ------------------------------------------------------------------ */

import { useEffect, type ReactNode } from "react";
import { useTheme } from "./theme-store";

export function ThemeHost({ children }: { children: ReactNode }) {
  useEffect(() => {
    useTheme.getState().hydrate();
  }, []);
  return <>{children}</>;
}
