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
      // Explicit 192/512 declarations so Chrome's desktop install checker
      // finds the required sizes. The SVG actually renders at any size, but
      // the manifest validator looks for the literal "192x192" / "512x512"
      // tokens in `sizes`. Leaving "any" too covers higher-DPI surfaces.
      { src: "/icon.svg",          sizes: "192x192 512x512 any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "192x192 512x512 any", type: "image/svg+xml", purpose: "maskable" },
    ],
    categories: ["business", "productivity"],
  };
}
