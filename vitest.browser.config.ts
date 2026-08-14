import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["tests/browser/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
