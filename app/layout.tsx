import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { InstallProvider } from "@/components/install-provider";

// Next.js Metadata API does NOT auto-prefix `manifest` and `icons` hrefs
// with basePath. The generated HTML ends up with:
//
//   <link rel="manifest" href="/manifest.webmanifest"/>
//   <link rel="icon" href="/icon.svg" type="image/svg+xml"/>
//
// which the browser resolves against the host root, not the basePath —
// so on `harshj111186.github.io/stock-app-v2/` it fetches
// `harshj111186.github.io/manifest.webmanifest` and 404s. Chrome DevTools
// then says "No manifest detected" and silently disables install.
//
// We hardcode the basePath here (matches `repo` in next.config.mjs +
// `BASE` in app/manifest.ts). NODE_ENV gates so dev (basePath="") still
// works locally.
const isProd = process.env.NODE_ENV === "production";
const BASE   = isProd ? "/stock-app-v2" : "";

export const metadata: Metadata = {
  title: "Stock Manager",
  description: "Two-godown stock manager — v2",
  applicationName: "Stock Manager",
  // Explicit basePath-prefixed manifest URL — see header comment.
  manifest: `${BASE}/manifest.webmanifest`,
  appleWebApp: {
    capable: true,
    title: "Stock Manager",
    statusBarStyle: "black-translucent",
    // Explicit apple-touch-icon link — file-based auto-detection isn't
    // reliable for apple-icon.svg in Next 15.0.3 dev mode.
    startupImage: undefined,
  },
  icons: {
    icon:  [{ url: `${BASE}/icon.svg`, type: "image/svg+xml" }],
    apple: [{ url: `${BASE}/icon.svg`, type: "image/svg+xml" }],
  },
  formatDetection: { telephone: false },
};

// Two theme-colors: light/dark via prefers-color-scheme so the address bar
// and standalone status bar match the active theme. interactiveWidget keeps
// inputs visible above the keyboard on mobile.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)",  color: "#09090b" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* InstallProvider registers /sw.js and captures the
            beforeinstallprompt event so the in-app Install button can fire
            it later. Wraps Providers so the auth context can use the install
            hook if we ever surface "install" inside login/pending screens. */}
        <InstallProvider>
          <Providers>{children}</Providers>
        </InstallProvider>
      </body>
    </html>
  );
}
