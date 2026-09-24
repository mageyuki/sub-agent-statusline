import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    allowOnly: false,
    include: ["test/package.integration.test.ts"],
    hookTimeout: 120_000,
  },
});
