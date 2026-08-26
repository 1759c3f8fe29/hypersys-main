import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // The default 5s assumes the suite has the machine to itself. It does not:
    // 40 jsdom environments over 4 cores put the full run at load average ~21,
    // and two *synchronous* render tests reported "timed out in 5000ms" — a
    // different two on each run, each passing in under a second when run alone.
    // That is CPU starvation, and a gate that fails on a different test every
    // time is worse than a slow one, because the next real regression gets
    // waved off as "that flaky one again". A genuine hang still fails, at 20s.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
