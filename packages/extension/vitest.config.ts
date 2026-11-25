import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 120000,
    sequence: { concurrent: false },
  },
});
