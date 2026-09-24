# Development and testing

This guide explains how to set up the project locally, which commands to run, and how to think about tests for `opencode-subagent-statusline`.

Practical rule:

> Vitest includes deterministic logic and native component checks. Qualification with synthetic data inside actual OpenCode/OpenTUI hosts validates only the cases exercised. Genuine execution and normal TUI interaction require separate user-observed acceptance.

## Requirements

Use the package's current toolchain: **Node.js `>=22.13`**, **pnpm `11.2.2`**, and the frozen lockfile. The baseline CI job stays on **22.13**. Native OpenTUI tests additionally need isolated official Node **26.4.0**; that does not raise the product engine floor or replace your normal runtime.

## Local install

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

## Main commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build the package with `tsup`. |
| `pnpm dev` | Run `tsup --watch`. |
| `pnpm typecheck` | Run TypeScript checks without emitting files. |
| `pnpm test` | Run the Vitest suite once. |
| `pnpm exec tsc --noEmit -p tsconfig.test.json` | Typecheck source tests, integration fixtures and both Vitest configs; inherited exclusions are overridden. |
| `pnpm test:package` | Build first, then pack and parse the actual artifact's runtime/declaration graph. |
| `pnpm test:watch` | Run Vitest in watch mode. |
| `pnpm test:coverage` | Generate V8 coverage. |
| `pnpm pack --dry-run` | Simulate the npm package contents. |

Recommended pre-PR checklist:

```sh
pnpm typecheck
pnpm exec tsc --noEmit -p tsconfig.test.json
pnpm test
pnpm test:package
pnpm audit --prod --audit-level moderate
```

If packaging or published files changed:

```sh
pnpm pack --dry-run
```

## Build outputs

The build cleans `dist` once before `tsup.config.ts` runs its configurations (`clean:false` individually):

| Source | Output | Use |
| --- | --- | --- |
| `src/tui.tsx` | `dist/tui.js` + types | Unbundled, host-runtime-free lazy bridge. |
| `src/tui-v1.tsx` | `dist/tui-v1.js` + types | Bundled V1 adapter/shared view. |
| `src/tui-v2.tsx` | `dist/tui-v2.js` + types | Separately bundled V2 adapter/shared view. |
| `src/index.ts` | `dist/index.js` + types | Experimental V1-only runtime. |

Host API/theme, Solid and OpenTUI are external singletons. `@opencode/client` is type-only, never a runtime import. Packaged tests use TypeScript's parser, validate lazy targets/declarations, import the bridge without host dependencies, and inspect build metadata for bundled host code or V1 fallback in V2. Ordinary tests exclude the package suite so stale `dist` cannot produce a false result. Both Vitest configs use `allowOnly: false`. The pack test disables lifecycle hooks with pnpm 11's `--config.ignore-scripts=true`; `prepack` still explicitly builds during normal packing.

Package entrypoints:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
opencode-subagent-statusline/runtime
```

## TypeScript files

| File | Role |
| --- | --- |
| `tsconfig.json` | Base source config. NodeNext, ES2022, strict, JSX for `@opentui/solid`. |
| `tsconfig.test.json` | Test config for Vitest and setup files. |
| `tsup.config.ts` | Runtime and TUI build config. |

## Test strategy

The project uses Vitest with two main layers:

1. **Unit tests** for deterministic logic.
2. **Runtime integration tests** for filesystem and OpenCode-style event handling.

Native view/setup tests exercise OpenTUI where available, but do not replace actual OpenCode-host interaction qualification.

## Required native lane and actual hosts

Ordinary Node 22/24 skips only the capability-gated cases when `node:ffi` is unavailable; do not rely on a fixed skip count as the suite grows. Select an isolated official Node **26.4.0** binary as `node`, probe FFI, then enable it explicitly in **both parent and workers**:

```sh
node --experimental-ffi --input-type=module -e "await import('node:ffi')"
node --experimental-ffi node_modules/vitest/vitest.mjs run --execArgv=--experimental-ffi
```

The required CI native job runs this same Node/Vitest suite and rejects any pending/skipped/todo tests through the JSON reporter. Ordinary Node alone is not full native verification.

Install the same tarball into three isolated trees with `npm install --ignore-scripts --no-audit --no-fund` and ordinary peer resolution (no force/legacy-peer escape):

| Actual host | Explicit API/theme peers | Installed shared peers |
| --- | --- | --- |
| V1 1.14.50 | `@opencode-ai/plugin@1.14.50` | core/solid `0.4.0`, Solid `1.9.12` |
| V1 1.18.29 | `@opencode-ai/plugin@1.18.29` | core/solid `0.4.5`, Solid `1.9.12` |
| V2 2.0.11 | `@opencode/plugin@2.0.11`, `@opencode/theme@2.0.11` | core/solid `0.5.10`, Solid `1.9.12` |

Here core/solid means `@opentui/core` and `@opentui/solid`. Plugin API/theme peers are optional alternatives: the opposite API must be absent, with no forced V2 theme on V1. Broad published peer ranges do not override OpenTUI's exact Solid peer. V1 1.14.50 actually overrides runtime modules with OpenTUI **0.2.9** / Solid **1.9.10**; its installed tree alone cannot qualify the shared view.

Use fresh HOME/config/data/cache/state/runtime directories, no user credentials/services, and V2 `--standalone`. Register V2's installed `dist` directory, not the root/file. Record the real tarball path/hash, manifests, lockfiles and host observations. Exercise V1 navigation/prompt return/history/selection/mouse/scroll/collapse/cleanup; V2 additionally needs real palette handoff, Alt+B/Esc precedence, immediate parent typing, modal/modifier exclusion, resize and unload/reload. Gate Enter on confirmed list/palette focus and stop only owned process groups. Label synthetic data honestly; genuine normal-TUI execution acceptance remains separate. Missing checks remain unmet, not permission to raise the V1 floor or claim arbitrary V2 support.

Cleanup evidence combines public plugin deactivation/config removal while the host stays alive, a bounded check for snapshot/contribution activity after an owned metadata update, and native ownership tests. Host-process termination alone does not prove plugin cleanup. Attempt the public host quit action separately and disclose any forced termination. Prove wheel displacement from a non-saturated position, not merely that a wheel event was sent.

## Test map

| File | Validates |
| --- | --- |
| `src/events.test.ts` | Event parsing, ID extraction, correlation, malformed payload safety. |
| `src/state.test.ts` | State, counters, transitions, pruning, persistence, normalization. |
| `src/render.test.ts` | Text rendering, collapse, visibility, duration, tokens, color/no-color. |
| `src/reconcile.test.ts` | Status normalization, stale-running, backoff, fail-closed behavior. |
| `src/text-width.test.ts` | Terminal column width for CJK/full-width text, combining marks, and truncation. |
| `src/tui.test.ts` | Command registration, `Alt+B` keybinding, legacy fallback. |
| `src/tui-entry.test.ts`, `test/package.integration.test.ts` | Lazy host selection and actual packed runtime/declaration graphs. |
| `src/tui-view.test.ts`, `test/tui-v1-lifecycle.integration.test.ts` | Shared rendering/scrolling and native V1 slot/focus/cleanup ownership. |
| `src/tui-v2-state.test.ts`, `src/tui-v2-snapshot.test.ts`, `src/tui-v2-focus.test.ts` | V2 data freshness, serialized persistence and public focus ownership. |
| `test/tui-v2.integration.test.ts` | Native V2 setup, key dispatch, slots, preferences and disposal. |
| `test/index.integration.test.ts` | Runtime plugin, `state.json`, `status.txt`, preserve-state, filesystem failures. |
| `test/helpers/runtime-harness.ts` | Helpers for temp dirs, fixtures, env vars, and fake time. |
| `test/setup.ts` | Global cleanup for timers, mocks, env vars, and temp dirs. |

## Coverage

Configured in `vitest.config.ts`:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "lcov"],
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts", "src/tui.tsx"],
}
```

Important:

> Coverage includes `.ts`, not `.tsx`; the bridge also has an explicit exclusion. Native behavioral tests run separately from coverage accounting. Neither a coverage percentage nor a green source suite certifies the complete actual-host TUI.

Coverage focuses on deterministic `.ts` modules: events, state, render, reconcile, text width helpers, commands, and runtime.

## Arrange / Act / Assert

Tests should follow this structure:

```ts
it("persists a supported event", async () => {
  // Arrange
  const harness = await createRuntimeHarness();
  const plugin = await SubagentStatusline({} as Parameters<typeof SubagentStatusline>[0]);
  const event = await readJsonFixture("session-created");

  // Act
  await plugin.event?.({ event } as never);

  // Assert
  const state = await readRuntimeState(harness.statePath);
  expect(state.children.ses_child_1.status).toBe("running");
});
```

Prefer semantic assertions over large snapshots.

Good:

```ts
expect(output).toContain("1 running");
expect(output).toContain("Review auth changes");
```

More brittle:

```ts
expect(output).toMatchSnapshot();
```

## Adding a unit test

1. Identify the behavior to protect.
2. Pick the colocated test file:
   - `src/events.test.ts`
   - `src/state.test.ts`
   - `src/render.test.ts`
   - `src/reconcile.test.ts`
   - `src/tui.test.ts`
3. Build minimal inputs.
4. Call the public function or helper under test.
5. Assert visible behavior, not accidental implementation detail.

Conceptual example:

```ts
it("does not count tool wrappers", () => {
  const state = createEmptyState();

  upsertRunningChild(state, {
    id: "tool:prt_1",
    source: "tool",
  });

  expect(state.totalExecuted).toBe(0);
});
```

## Adding a runtime integration test

Integration tests live in `test/**/*.integration.test.ts`.

Use the harness to isolate filesystem and env vars:

```ts
it("writes runtime output after an event", async () => {
  const harness = await createRuntimeHarness();
  const plugin = await SubagentStatusline({} as Parameters<typeof SubagentStatusline>[0]);
  const event = await readJsonFixture("session-created");

  await plugin.event?.({ event } as never);

  expect(await readStatusText(harness.textPath)).toContain("Review auth changes");
});
```

Useful helpers:

| Helper | Use |
| --- | --- |
| `createRuntimeHarness()` | Creates temp dir and isolated state. |
| `readJsonFixture(name)` | Reads `test/fixtures/events/<name>.json`. |
| `readRuntimeState(path)` | Reads `state.json`. |
| `readStatusText(path)` | Reads `status.txt`. |
| `pathExists(path)` | Checks existence without throwing. |
| `useFrozenTime(iso)` | Freezes time with fake timers. |

## Fixtures

Fixtures live in:

```txt
test/fixtures/events/
```

Keep them small and representative. Avoid huge dumps unless payload size is part of the behavior under test.

## Fake timers

For time-dependent tests:

- freeze time explicitly in Arrange;
- avoid shared global state;
- let `test/setup.ts` restore real timers after the test.

```ts
useFrozenTime("2026-01-01T00:00:00.000Z");
```

## Test environment variables

`test/setup.ts` restores plugin env vars after each test.

If a new env var is mutated by tests, add it to the cleanup list in `test/setup.ts`.

## Unit and actual-host boundaries

Avoid broad visual snapshots or a simulated OpenCode host in unit tests. Keep actual packed-host navigation and interaction checks in the isolated qualification procedure above, outside ordinary unit CI.

For real UI changes, prefer:

1. unit tests for extractable logic;
2. command tests if registration/keybindings changed;
3. native lifecycle/input tests and actual OpenCode-host qualification.

## Manual V1 TUI smoke test

When changing `src/tui-v1.tsx`, `src/tui-view.tsx`, `src/render.ts`, or visible V1 behavior:

1. Build:

   ```sh
   pnpm build
   ```

2. Configure OpenCode with an absolute path:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
   }
   ```

3. Restart OpenCode.
4. Run a delegation/subagent.
5. Verify sidebar, statuses, and duration.
6. Test `Alt+B`, `j/k`, arrows, `Enter`, and `Esc`.
7. If token/context data exists, confirm it does not break the row.
8. Check logs if the plugin does not load.

## CI

PR workflow: `.github/workflows/ci.yml`.

It runs:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm exec tsc --noEmit -p tsconfig.test.json
pnpm test:package
pnpm audit --prod --audit-level moderate
pnpm pack --dry-run
```

The separate Node 26.4.0 job probes FFI, runs the full source suite with both flags, and requires zero skips. Interactive actual-host qualification is separate from CI and must not introduce credentialed model calls into unit tests.

## Contribution practices

From `CONTRIBUTING.md`:

- prefer issue-first for non-trivial changes;
- keep PRs small and reviewable;
- use Conventional Commits;
- never commit secrets;
- explain what changed, why, and how it was validated.

Example commits:

```txt
feat: add runtime summary grouping
fix: handle missing token metadata
docs: clarify local setup
```

## Quick checklist by change type

| Change | Minimum recommended validation |
| --- | --- |
| Docs only | Check links and Markdown formatting. |
| Events/state/render | `pnpm test`, focused tests. |
| TypeScript/API | `pnpm typecheck`, `pnpm test`. |
| Visual TUI | `pnpm build`, manual OpenCode smoke test. |
| Packaging | `pnpm build`, `pnpm pack --dry-run`. |
| CI/release | Review workflows and document impact. |
