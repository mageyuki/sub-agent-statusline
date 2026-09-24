import { solidPlugin } from "esbuild-plugin-solid";
import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Do not bundle this entry: bundling can pull host runtimes into its imports.
    entry: { tui: "src/tui.tsx" },
    format: ["esm"],
    target: "node22",
    dts: true,
    bundle: false,
    splitting: false,
    clean: false,
    outDir: "dist",
  },
  {
    entry: {
      index: "src/index.ts",
      "tui-v1": "src/tui-v1.tsx",
      "tui-v2": "src/tui-v2.tsx",
    },
    format: ["esm"],
    target: "node22",
    dts: true,
    bundle: true,
    splitting: false,
    clean: false,
    outDir: "dist",
    metafile: true,
    external: [
      "@opencode-ai/plugin",
      "@opencode-ai/plugin/*",
      "@opencode/plugin",
      "@opencode/plugin/*",
      "@opencode/client",
      "@opencode/client/*",
      "@opencode/theme",
      "@opencode/theme/*",
      "@opentui/core",
      "@opentui/core/*",
      "@opentui/solid",
      "@opentui/solid/*",
      "solid-js",
      "solid-js/*",
    ],
    esbuildPlugins: [
      solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } }),
    ],
  },
]);
