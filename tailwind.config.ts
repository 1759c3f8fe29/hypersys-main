import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
// ESM import rather than the `require("tailwindcss-animate")` this replaces. The
// file already imports `plugin` this way, so mixing the two styles bought
// nothing, and Tailwind loads this config through its own esbuild/jiti pass which
// resolves the package's CJS entry either way.
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      // Platform UI font stack, mirroring `body` and `h1-h6` in src/index.css.
      // Both halves must stay in sync with that file: these arrays generate the
      // `font-sans` / `font-display` utilities, and index.css sets the same stack
      // as the inherited default, so a disagreement shows up as headings in one
      // family and body copy in another.
      //
      // The webfonts these used to name (Inter / Space Grotesk) are no longer
      // loaded — the Google Fonts `@import` was removed in the native-look pass
      // because it blocks first paint, fails offline, and costs a third-party
      // request on every launch of an installed desktop app.
      //
      // `display` is intentionally the *same* stack rather than a second family:
      // the platform already picks its display cut (SF Pro Display, Segoe UI
      // Variable Display) from `system-ui` by optical size, so naming a different
      // face would override that with a guess. `font-display` is therefore kept
      // as a live utility — four components use it — but it now means "heading
      // type" rather than "different typeface", and the visual hierarchy comes
      // from the weight and tracking those components already set.
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Noto Sans',
          'sans-serif',
          'Apple Color Emoji',
          'Segoe UI Emoji',
          'Segoe UI Symbol',
          'Noto Color Emoji',
        ],
        display: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Noto Sans',
          'sans-serif',
        ],
        // Code and any tabular/numeric readout. Previously absent, which meant
        // `font-mono` fell back to Tailwind's default stack — that starts with
        // `ui-monospace`, so it was already reasonable, but it put Menlo ahead of
        // the Windows/Linux entries. Named explicitly so the code viewer and the
        // token/latency readouts resolve the same way the platform terminal does.
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'SF Mono',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-20px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s ease-out",
        "slide-in-left": "slide-in-left 0.3s ease-out",
        "scale-in": "scale-in 0.2s ease-out",
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    // `max-hover:` — applies only on devices that cannot hover (touch).
    // Tailwind ships `hover:` but no built-in inverse, and several controls in
    // this app are revealed by `group-hover`, which never fires on a phone:
    // without this they are permanently invisible and their action unreachable.
    plugin(({ addVariant }) => {
      addVariant("max-hover", "@media (hover: none) and (pointer: coarse)");
    }),
  ],
} satisfies Config;
