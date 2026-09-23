import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
import { solidPlugin } from "esbuild-plugin-solid";

// Reuse the build's esbuild/Solid transform without adding another dependency.
const { build } = createRequire(import.meta.resolve("tsup"))("esbuild");
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [{ find: /^solid-js$/, replacement: require.resolve("solid-js/dist/solid.js") }],
  },
  plugins: [{
    name: "monitor-solid-test-transform",
    enforce: "pre",
    async transform(_source, id) {
      if (!id.endsWith(".tsx") || id.includes("node_modules")) return;
      const result = await build({
        entryPoints: [id],
        write: false,
        bundle: false,
        format: "esm",
        sourcemap: "inline",
        plugins: [solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } })],
      });
      return { code: result.outputFiles[0].text, map: null };
    },
  }],
  test: {
    environment: "node",
    forbidOnly: true,
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/tui.tsx"],
    },
  },
});
