import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
let scratch: string;
let packedRoot: string;
type Edge = { specifier: string; lazy: boolean };

// Parse the emitted artifact, including re-exports, import types and require calls.
function imports(file: string, source: string): Edge[] {
  const edges: Edge[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const requireFactories = new Set<string>();
  const requireFunctions = new Set(["require", "__require"]);
  function collect(node: ts.Node) {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "createRequire") {
      requireFactories.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
      requireFactories.has(node.initializer.expression.text)) requireFunctions.add(node.name.text);
    ts.forEachChild(node, collect);
  }
  collect(ast);
  const add = (node: ts.Node | undefined, lazy = false) => {
    if (!node || !ts.isStringLiteralLike(node)) throw new Error(`Nonliteral import in ${file}`);
    edges.push({ specifier: node.text, lazy });
  };
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], true);
      else if (ts.isIdentifier(node.expression) && requireFunctions.has(node.expression.text)) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const ref of ast.referencedFiles) edges.push({ specifier: ref.fileName, lazy: false });
  return edges;
}

async function graph(entry: string, includeLazy = true) {
  const files = new Set<string>();
  const externals = new Set<string>();
  async function walk(file: string) {
    if (files.has(file)) return;
    expect(relative(packedRoot, file).startsWith(".."), `Escaping packed graph: ${file}`).toBe(false);
    expect((await stat(file)).isFile(), `Missing packed target ${file}`).toBe(true);
    files.add(file);
    if (file.endsWith(".json")) return;
    for (const edge of imports(file, await readFile(file, "utf8"))) {
      if (edge.lazy && !includeLazy) continue;
      if (!edge.specifier.startsWith(".")) {
        externals.add(edge.specifier);
        continue;
      }
      let target = resolve(dirname(file), edge.specifier);
      if (file.endsWith(".d.ts") && /\.js$/.test(target)) target = target.replace(/\.js$/, ".d.ts");
      await walk(target);
    }
  }
  await walk(join(packedRoot, "dist", entry));
  return { files: [...files].map(file => relative(packedRoot, file)), externals: [...externals] };
}

beforeAll(async () => {
  await mkdir("/tmp/opencode", { recursive: true });
  scratch = await mkdtemp("/tmp/opencode/subagent-package-");
  // pnpm 11 pack reads ignoreScripts but exposes it only as a config option.
  await exec("pnpm", ["pack", "--config.ignore-scripts=true", "--pack-destination", scratch], {
    cwd: project, env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  const tarballs = (await readdir(scratch)).filter(file => file.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  await exec("tar", ["-xzf", join(scratch, tarballs[0]), "-C", scratch]);
  packedRoot = join(scratch, "package");
});
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

it("preserves public exports and ships both private adapters and declarations", async () => {
  const manifest = JSON.parse(await readFile(join(packedRoot, "package.json"), "utf8"));
  expect(manifest.exports).toEqual({
    ".": { types: "./dist/tui.d.ts", import: "./dist/tui.js" },
    "./tui": { types: "./dist/tui.d.ts", import: "./dist/tui.js" },
    "./runtime": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  });
  for (const name of ["tui", "tui-v1", "tui-v2", "index"]) {
    for (const extension of ["js", "d.ts"]) {
      expect((await readdir(join(packedRoot, "dist")))).toContain(`${name}.${extension}`);
    }
  }
  expect(manifest.engines.node).toBe(">=22.13");
  expect(manifest.peerDependencies).toEqual({
    "@opencode-ai/plugin": ">=1.14.50 <2", "@opencode/plugin": "2.0.11",
    "@opencode/theme": "2.0.11", "@opentui/core": ">=0.4.0 <0.6",
    "@opentui/solid": ">=0.4.0 <0.6", "solid-js": ">=1.9.12 <2",
  });
  for (const peer of ["@opencode-ai/plugin", "@opencode/plugin", "@opencode/theme"]) {
    expect(manifest.peerDependenciesMeta[peer].optional).toBe(true);
  }
  expect(manifest.dependencies?.["@opencode/client"]).toBeUndefined();
});

it("imports the real packed bridge in a host-free process", async () => {
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
    const { default: plugin } = await import(${JSON.stringify(pathToFileURL(join(packedRoot, "dist/tui.js")).href)});
    console.log(JSON.stringify({ id: plugin.id, tui: typeof plugin.tui, setup: typeof plugin.setup }));
  `], { cwd: scratch, env: { ...process.env, NODE_PATH: "" } });
  expect(JSON.parse(stdout)).toEqual({ id: "subagent-statusline.tui", tui: "function", setup: "function" });
});

it("keeps the bridge static graph host-free and ships both lazy import targets", async () => {
  expect(await graph("tui.js", false)).toEqual({ files: ["dist/tui.js"], externals: [] });
  const lazy = await graph("tui.js");
  expect(lazy.files).toEqual(expect.arrayContaining(["dist/tui-v1.js", "dist/tui-v2.js"]));
});

it("ships every relative runtime and declaration reference", async () => {
  const files = await readdir(join(packedRoot, "dist"), { recursive: true });
  for (const file of files.filter(file => file.endsWith(".js") || file.endsWith(".d.ts"))) {
    await graph(file);
  }
});

it("keeps host families and the type-only V2 client out of the wrong runtime graph", async () => {
  const v1 = await graph("tui-v1.js");
  const v2 = await graph("tui-v2.js");
  expect(v1.externals.some(name => /^@opencode\/(plugin|theme)(\/|$)/.test(name))).toBe(false);
  expect(v2.externals.some(name => /^@opencode-ai\//.test(name))).toBe(false);
  expect(v2.externals).not.toContain("node:sqlite");
  expect(v2.files).not.toContain("dist/tui-v1.js");
  expect(v2.files).not.toContain("dist/index.js");
  for (const file of (await readdir(join(packedRoot, "dist"))).filter(file => file.endsWith(".js"))) {
    const runtime = await graph(file);
    expect(runtime.externals.some(name => /^@opencode\/client(\/|$)/.test(name))).toBe(false);
  }
});

it("externalizes singleton hosts and excludes V1 parsing/fallback from the V2 build inputs", async () => {
  const metadata = JSON.parse(await readFile(join(packedRoot, "dist/metafile-esm.json"), "utf8")) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
  };
  expect(Object.keys(metadata.inputs).some(name => /node_modules/.test(name))).toBe(false);
  const output = Object.entries(metadata.outputs).find(([name]) => name.endsWith("/tui-v2.js"))?.[1];
  expect(output, "V2 output missing from build metadata").toBeDefined();
  const included = Object.entries(output!.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([name]) => name);
  expect(included).toContain("src/tui-v2.tsx");
  for (const forbidden of ["src/tui-v1.tsx", "src/events.ts", "src/logs.ts", "src/index.ts"]) {
    expect(included).not.toContain(forbidden);
  }
});
