import type { MetadataRoute } from "next";

// `output: "export"` in next.config.mjs requires dynamic routes to opt into
// static generation explicitly. Without this the manifest 500s in dev and
// fails the export build.
export const dynamic = "force-static";

// Next.js auto-prefixes paths with basePath (`/stock-app-v2` in prod), so
// `/` here resolves to `/stock-app-v2/` once deployed.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stock Manager — Rye Electricals",
    short_name: "Stock",
    description: "Two-godown stock manager — inventory, transactions, pricing, reports.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#0891b2",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
    categories: ["business", "productivity"],
  };
}
