import type { Config } from "tailwindcss";

// ─────────────────────────────────────────────────────────────────────────────
// Design language: "Bold Premium" (2026-05 reskin)
//
// The whole app is restyled WITHOUT rewriting className soup by remapping the
// two scales the components already lean on everywhere:
//   • `zinc`  → a refined cool-slate neutral ramp with a deep, OLED-leaning
//               dark end (premium depth; cards sit above an inkier app bg).
//   • `cyan`  → a bold violet accent ramp (the new brand colour). Primary
//               actions are violet (500) with WHITE labels.
//
// Semantic stock-status colours are deliberately LEFT as Tailwind defaults so
// they never collide with the accent: emerald = healthy, amber = low,
// rose = out/danger.
//
// Steps are monotonic + luminance-matched to stock Tailwind so existing
// contrast relationships (text-zinc-500 on cards, etc.) survive the swap.
// ─────────────────────────────────────────────────────────────────────────────

export default {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // UI / body — unchanged workhorse.
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        // Display — headings, brand, big KPI numbers. Geometric grotesk reads
        // "data-grade premium" and has clean tabular figures.
        display: ["Space Grotesk", "Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        // Cool-slate neutral ramp (remaps `zinc`). Deep OLED-leaning bottom.
        zinc: {
          50:  "#f6f7f9",
          100: "#eceef2",
          200: "#dde1e9",
          300: "#c3c9d6",
          400: "#939bad",
          500: "#69728a",
          600: "#4a5263",
          700: "#2f3647",
          800: "#1d2230",
          900: "#141822",
          950: "#0b0d12",
        },
        // Bold violet accent (remaps `cyan`). Primary = 500 (#7c3aed) + white.
        cyan: {
          50:  "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#7c3aed",
          600: "#6d28d9",
          700: "#5b21b6",
          800: "#4c1d95",
          900: "#2e1065",
          950: "#1e0b4d",
        },
        // Semantic alias usable in new code (maps to the violet brand).
        brand: {
          DEFAULT: "#7c3aed",
          fg: "#ffffff",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          foreground: "#ffffff",
        },
      },
      borderRadius: {
        // Slightly larger, consistent premium radii.
        lg: "0.625rem",    // 10px — controls
        xl: "0.875rem",    // 14px — cards
        "2xl": "1.125rem", // 18px — sheets / mobile cards
      },
      boxShadow: {
        // Soft, layered elevation for light mode; dark mode leans on borders.
        sm: "0 1px 2px 0 rgb(15 23 42 / 0.04)",
        DEFAULT: "0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.06)",
        md: "0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 6px -2px rgb(15 23 42 / 0.06)",
        lg: "0 12px 28px -8px rgb(15 23 42 / 0.14)",
        // Accent glow for primary / active surfaces.
        glow: "0 0 0 1px rgb(124 58 237 / 0.25), 0 8px 24px -6px rgb(124 58 237 / 0.35)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out both",
        "slide-up": "slide-up 0.24s cubic-bezier(0.16,1,0.3,1) both",
      },
    },
  },
  plugins: [],
} satisfies Config;
