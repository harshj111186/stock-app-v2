import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { InstallProvider } from "@/components/install-provider";

// PWA URL hardcoding — see also public/manifest.webmanifest.
//
// Next.js Metadata API does NOT auto-prefix `manifest` and `icons` hrefs
// with basePath, AND `process.env.NODE_ENV` evaluates to `undefined`
// (or something falsy) inside this file at static-export build time, so a
// conditional `isProd ? "/stock-app-v2" : ""` resolves to "" — empirically
// confirmed by inspecting the deployed HTML after commit f6c5807.
//
// Net effect of trying to be clever: the generated HTML ended up with
//   <link rel="manifest" href="/manifest.webmanifest"/>
// which browsers resolve against the host root, hit 404, and DevTools
// shows "No manifest detected" → Chrome refuses install.
//
// Fix: hardcode the basePath as a plain string. This means dev mode
// (basePath="") will have a slightly wrong link, but dev is for `next dev`
// where install/PWA isn't being tested anyway. If `repo` in
// next.config.mjs ever changes from "stock-app-v2", update both this file
// and public/manifest.webmanifest.
const BASE = "/stock-app-v2";

export const metadata: Metadata = {
  title: "Stock Manager",
  description: "Two-godown stock manager — v2",
  applicationName: "Stock Manager",
  // Points at the static file in public/. Next no longer auto-generates a
  // manifest because app/manifest.ts has been removed in favour of the
  // static file — see commit log.
  manifest: `${BASE}/manifest.webmanifest`,
  appleWebApp: {
    capable: true,
    title: "Stock Manager",
    statusBarStyle: "black-translucent",
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
//
// userScalable=false + maximumScale=1: kills iOS Safari's auto-zoom on
// input focus (which kept yanking the page around when staff tapped the
// reconciliation cells) and disables manual pinch-zoom. The app is a
// data-entry tool, not a document; zoom isn't useful here.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
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
