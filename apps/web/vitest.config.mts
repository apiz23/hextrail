import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      // `server-only` is a Next.js build-time marker package that is not
      // installed as a runtime dependency. Unit tests that import server
      // modules need it stubbed.
      "server-only": resolve(import.meta.dirname, "./src/test/server-only.ts"),
    },
  },
});
