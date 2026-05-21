import type { MetadataRoute } from "next";

// `output: "export"` in next.config.mjs requires dynamic routes to opt into
// static generation explicitly. Without this the manifest 500s in dev and
// fails the export build.
export const dynamic = "force-static";

// IMPORTANT: contrary to my earlier comment, Next.js does NOT auto-prefix
// paths in manifest.ts with basePath. Paths starting with "/" inside the
// manifest are interpreted by the browser as absolute from the host root,
// not from the basePath:
//
//   "/icon.svg"      → https://harshj111186.github.io/icon.svg          (404!)
//   "/stock-app-v2/icon.svg" → https://harshj111186.github.io/stock-app-v2/icon.svg  ✓
//
// This was the cause of the "install button never appears on desktop" bug:
// Chrome fetched the manifest, tried to validate the declared icons, hit
// 404s, marked the site as ineligible, and silently hid the install icon.
//
// We hardcode the basePath here (gated on NODE_ENV for dev). It matches
// `repo` in next.config.mjs — if that ever changes, change it here too.
const isProd   = process.env.NODE_ENV === "production";
const BASE     = isProd ? "/stock-app-v2" : "";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stock Manager — Rye Electricals",
    short_name: "Stock",
    description: "Two-godown stock manager — inventory, transactions, pricing, reports.",
    // start_url and scope MUST be basePath-prefixed (see header comment).
    // Without the prefix, Chrome treats the app's scope as the entire
    // harshj111186.github.io origin, which both fails install eligibility
    // and breaks the v1 stock-app sharing the same domain.
    start_url: `${BASE}/`,
    scope:     `${BASE}/`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#0891b2",
    icons: [
      // Explicit 192/512 declarations so Chrome's desktop install checker
      // finds the required sizes. The SVG actually renders at any size, but
      // the manifest validator looks for the literal "192x192" / "512x512"
      // tokens in `sizes`. Leaving "any" too covers higher-DPI surfaces.
      { src: `${BASE}/icon.svg`,          sizes: "192x192 512x512 any", type: "image/svg+xml", purpose: "any" },
      { src: `${BASE}/icon-maskable.svg`, sizes: "192x192 512x512 any", type: "image/svg+xml", purpose: "maskable" },
    ],
    categories: ["business", "productivity"],
  };
}
