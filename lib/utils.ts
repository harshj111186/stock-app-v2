import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fmtN = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString("en-IN");

export const fmtMoney = (n: number | null | undefined) =>
  "₹" + Math.round(n ?? 0).toLocaleString("en-IN");

// Today's date as yyyy-mm-dd in the DEVICE's timezone (IST here) — NOT
// `toISOString()`, which is UTC and stamps yesterday's date between
// 00:00 and 05:30 IST. Use this for txn dates, commit notes, filenames.
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ─── stock-status rules (ONE definition app-wide) ──────────────────────
// The audit found three diverging "low stock" rules (dashboard: reorder
// sum, items page: flat ≤2, godown view: per-godown reorder). Canonical:
//   combined scope  → total ≤ max(reorder_A + reorder_B, 2)
//   per-godown scope → that godown's total ≤ max(reorder_X, 2)
// The floor of 2 keeps a sane alert on items with no reorder points set.
type ReorderFields = { reorder_point_a?: number | null; reorder_point_b?: number | null };
export function lowThresholdCombined(i: ReorderFields): number {
  return Math.max((i.reorder_point_a || 0) + (i.reorder_point_b || 0), 2);
}
export function lowThresholdGodown(i: ReorderFields, godown: "A" | "B"): number {
  return Math.max((godown === "A" ? i.reorder_point_a : i.reorder_point_b) || 0, 2);
}
export type StockStatus = "out" | "low" | "ok";
export function stockStatus(total: number, threshold: number): StockStatus {
  return total === 0 ? "out" : total <= threshold ? "low" : "ok";
}

// ─── pricing math (shared + defensive) ──────────────────────────────────
// `discount` is stored as a fraction (0.43), but legacy rows could hold a
// percent (43). Guard every reader so one bad row can't go negative.
export const asFraction = (d: number | null | undefined): number => {
  const n = d ?? 0;
  return n > 1 ? n / 100 : n;
};
export const DEFAULT_GST = 0.18;
export const netRate = (lp: number | null | undefined, discount: number | null | undefined): number =>
  (lp ?? 0) * (1 - asFraction(discount));

// Neutralise spreadsheet formula injection for FREE-TEXT CSV fields (notes,
// party names, models). Excel executes cells starting with = + - @.
export const csvSafe = (s: string): string => (/^[=+@-]/.test(s) ? "'" + s : s);

// ─── search helpers ────────────────────────────────────────────────────
// Normalise text for forgiving search: lowercase, turn every run of
// non-letter/number chars (brackets, dots, dashes, slashes…) into a single
// space, then trim. So "Phantom (BLDC) (WOOD)" → "phantom bldc wood".
// Unicode-aware (\p{L}\p{N}) so Devanagari/accented model names stay
// searchable — the old [^a-z0-9] stripped them entirely, making any
// non-Latin query match EVERYTHING.
export function normalizeText(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Multi-term AND search: every whitespace-separated term in `query` must
// appear somewhere in `haystack`, after both are normalised. Order doesn't
// matter and brackets are ignored, so one search box handles
// "phantom wood antique" or "blue 1200 daisy" → the right item.
export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalizeText(query);
  if (!q) return true;
  const hay = normalizeText(haystack);
  return q.split(" ").every((term) => hay.includes(term));
}

// Colour name → CSS background + auto-contrast text
const COLOUR_WORDS: Record<string, string | null> = {
  white: "#f6f6f4", ivory: "#fff8e7", cream: "#fdf6e3", pearl: "#eae0d5",
  angel: "#f0f8ff", satin: "#ece9e1",
  black: "#1a1a1a", matt: "#2b2b2b", matte: "#2b2b2b", magna: "#363636",
  grey: "#808080", gray: "#808080", smoke: "#7d7d7d", titanium: "#878681",
  steel: "#8b9ba8", graphite: "#404040", silver: "#bfc1c2", dusky: "#5e514a",
  brown: "#7d5a3f", dark: "#2a2a2a", coffee: "#6f4e37", walnut: "#5d4037",
  espresso: "#3e2723", wengewood: "#4f3a2c", wenge: "#4f3a2c",
  maple: "#a87844", maplewood: "#a87844", wood: "#8d6e44",
  honey: "#b88037", dune: "#b89968", tan: "#c39867", beige: "#d9c2a3",
  rose: "#c08679", rosewood: "#85433d", amber: "#bf7f30",
  copper: "#b87333", brass: "#b08d57", gold: "#c9a14b", golden: "#c9a14b",
  bronze: "#a06a35", antique: null,
  red: "#c53030", blue: "#2a5db0", green: "#2f855a", yellow: "#d4b51a",
  orange: "#dd7732", purple: "#7e3a8f", pink: "#d97391", maroon: "#7a1f1f",
  navy: "#1f2c5c", sky: "#6cb4e6", teal: "#198a89",
  midnight: "#191970", royal: "#5141a7", lavender: "#967bb6",
  american: null, gloss: null,
};
const COLOUR_MODS: Record<string, [number, number, number]> = {
  antique: [-15, -10, -20], dark: [-25, -25, -25], light: [20, 20, 20],
  gloss: [5, 5, 5], matt: [-10, -10, -10], matte: [-10, -10, -10],
};
const clamp = (v: number) => Math.max(0, Math.min(255, v));

export function colourCss(name: string | null | undefined): { bg: string; fg: string } | null {
  if (!name) return null;
  const norm = name.toLowerCase().replace(/[^a-z\s]/g, " ").trim();
  if (!norm) return null;
  const tokens = norm.split(/\s+/);
  const colours: string[] = [];
  const mods: [number, number, number][] = [];
  for (const t of tokens) {
    if (COLOUR_WORDS[t]) colours.push(COLOUR_WORDS[t] as string);
    if (COLOUR_MODS[t]) mods.push(COLOUR_MODS[t]);
  }
  let r = 0, g = 0, b = 0;
  if (!colours.length) {
    let h = 0;
    for (const c of name) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
    return { bg: `hsl(${Math.abs(h) % 360},30%,55%)`, fg: "#0f172a" };
  }
  for (const hex of colours) {
    r += parseInt(hex.slice(1, 3), 16);
    g += parseInt(hex.slice(3, 5), 16);
    b += parseInt(hex.slice(5, 7), 16);
  }
  r = Math.round(r / colours.length);
  g = Math.round(g / colours.length);
  b = Math.round(b / colours.length);
  for (const [dr, dg, db] of mods) { r = clamp(r + dr); g = clamp(g + dg); b = clamp(b + db); }
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { bg: `rgb(${r},${g},${b})`, fg: lum > 0.55 ? "#0f172a" : "#f8fafc" };
}
