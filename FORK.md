# Fork provenance: @mageyuki/opencode-subagent-statusline

Status:

- `0.7.0` is the published first release of the scoped name.
- `0.7.1` is an unpublished candidate. Its frozen-lockfile check and its isolated install of the current candidate (C, below) passed. Its actual-host CLI smoke is pending: the local explicit server requires a password, and no authenticated path has been supplied. It is not publishable yet.

## Baselines

- Original V2 pin (source): `a186ba9791931ccf148581a8cf6d20761882bd67`
- New runtime/source baseline (`main`, pre-merge): `646dea13ef48ec4eb0df30d75f6eff54ebfb41e7`
- Merged `main` for the `0.7.0` line (PR #3): `484a38ee3aef27551d10f0ff2bab3c7f61037b1e`
- `0.7.1` candidate source base: `484a38ee3aef27551d10f0ff2bab3c7f61037b1e`. The final commit and tarball hashes are supplied by the Controller handoff, not recorded here.

## Changes from the original pin

- Constant organization only, with unchanged values: `src/internal-policy.ts` (from `main`) holds internal runtime policy constants. Consumers: `src/logs.ts`, `src/state.ts`, `src/tui-v1.tsx`, `src/tui-v2-focus.ts`, `src/tui-v2-state.ts`.
- These are not topic behavior or public API changes. `package.json` exports and the public entry set are unchanged.
- Package identity is scoped: `@mageyuki/opencode-subagent-statusline`, with the fork description and repository metadata.
- Tests keep both the scoped identity check and the `main` peer/engine checks in `test/package.integration.test.ts`.

## Unchanged

- `assets/` and `LICENSE`: byte-identical to the original pin and `main`.
- `pnpm-lock.yaml`: NOT byte-identical to the original pin any more. The `0.7.1` candidate adds the source-only `@opentui/keymap` 0.5.10 closure (see below). All old package entries, versions and integrities are preserved. Existing snapshots are unchanged except the `@opencode-ai/plugin` 1.16.2 snapshot, which is re-keyed with a keymap context suffix (keymap 0.5.10) and keeps an optional keymap edge; its importer line changes only that peer-context suffix. The version stays `1.16.2`.
- Existing peer ranges and the `@opencode-ai/*` / `@opencode/*` host-peer ranges.
- Runtime `dist/` (9 files): byte-identical to the `0.7.0` package artifact (verified at packaging).

`FORK.md` is not part of the published package (`package.files` is `dist`, `assets`, `README.md`).

## 0.7.1 candidate

Relative to `484a38ee`:

- `package.json` version `0.7.1`.
- `peerDependenciesMeta` optional flags for `@opentui/core`, `@opentui/keymap`, `@opentui/solid`, and `solid-js`, alongside the existing flags.
- A new peer `@opentui/keymap` with range `>=0.4.0 <0.6`. It bounds the optional legacy-SDK keymap recursion to the already supported OpenTUI `<0.6` family. It is not a runtime import or dependency, and it is not a claim of `0.6` compatibility.
- Existing peer ranges are unchanged. No source, runtime, asset, or license change.
- Source-only devDependency: `@opentui/keymap` exact `0.5.10`, aligned with the existing `@opentui/core` and `@opentui/solid` 0.5.10 devDependencies. It is a source/build pin, not a published runtime dependency. The published package has no `dependencies` field.
- The published peer guard is unchanged: `@opentui/keymap` `>=0.4.0 <0.6`, optional. The devDependency does not declare `0.6` support and does not change the Node range (`>=22.13`).
- Lockfile: a narrow regeneration. The root keymap entry under `dependencies` (a production root entry from the earlier sync) is removed; the root keymap is a devDependency now. The `0.5.17` keymap/core closure from the earlier sync is removed. The `0.5.10` keymap closure is added. The `@opencode-ai/plugin` 1.16.2 snapshot is re-keyed to the 0.5.10 keymap context. No existing version or integrity changed, and no existing devDependency specifier changed.

## Failure chain behind the change

- The published `0.7.0` failed a private isolated install (Node 24.18.0, npm Arborist 9.4.0, config 10.8.1, scripts disabled, no audit, default resolution) with ERESOLVE on `@opentui/solid` 0.6.3 against `>=0.4.0 <0.6`.
- A trace of the optional-only candidate (UI peers optional, no keymap guard) showed the cause: optional `@opencode-ai/plugin` (the peer range resolved to 1.19.0 in that isolated tree) → optional `@opentui/keymap` (`>=0.4.5`) resolved to 0.6.3 → peer-optional `@opentui/solid` pinned exactly to 0.6.3. The same ERESOLVE remained. Optional flags alone did not fix it.
- The keymap guard addresses that chain. The live-host root cause is not separately established.

## Incident record

- During validation, a non-frozen pnpm run (triggered implicitly by `pnpm build`/`pnpm exec`) rewrote `pnpm-lock.yaml` beyond the keymap guard. The broader rewrite was reverted from the committed bytes; nothing was committed or published.
- That earlier sync: the captured rewrite was parsed against the committed lock. Only the narrow closure was applied, with `patch`. A structural check confirmed that every existing package entry and every pinned version and integrity is unchanged. Existing snapshots were unchanged except the `@opencode-ai/plugin` 1.16.2 re-key and its optional keymap edge. Each new entry's integrity matched the public registry's metadata for the same name and version.
- The earlier note that `@opencode-ai/plugin` was bumped is incorrect. Its version stays `1.16.2`; its snapshot was re-keyed with a keymap context suffix and gained an optional keymap edge.
- CI run 38411474329 (commit `ac16e48`): the ordinary install, typecheck, tests, test-source typecheck, package graph, and native full suite passed. The only failure was the production audit. Its safe public log lists paths of the form `.>@opentui/keymap>@opentui/solid>…` (seroval critical; brace-expansion and browserslist high). Those paths were reached through the root production keymap entry from the earlier sync. That historical failure is not the current state; see the devDependency correction above and the verification below.
- The source-only devDependency correction removes that root production path. The production audit now passes, as described below. This is a build-metadata correction. It is not a security fix for the advisories above, which still exist in the dev toolchain of this source repository.

## Verification of the 0.7.1 candidate

- Package fixture (existing 7 cases, extended): RED on the optional-only manifest (missing `@opentui/keymap` in the peer key set). GREEN after the metadata and lock change, 7/7. The literal guard-range expectation's own RED was not separately shown, because the key-set assertion failed first.
- Lockfile regeneration: `pnpm install --lockfile-only --ignore-scripts --offline` PASS. A structural check against the committed lock confirmed the changes described above.
- Frozen lockfile: `pnpm install --frozen-lockfile --ignore-scripts --offline` FAIL (a missing `@opentui/keymap` 0.5.10 tarball in the offline store). `pnpm install --frozen-lockfile --ignore-scripts` (locked public retrieval of that tarball) PASS, exit 0, and the lock stayed byte-identical.
- Production audit: `pnpm audit --prod --audit-level moderate` PASS, exit 0 ("No known vulnerabilities found"). Development-only advisories were not evaluated for this change.
- Build: `pnpm build` PASS. `pnpm typecheck` PASS. `tsc --noEmit -p tsconfig.test.json` PASS. The 7 package cases are unchanged and PASS.
- Isolated install of candidate C (the current candidate: source devDependency `@opentui/keymap` 0.5.10; tarball SHA256 `bea498e0cac0e359c950740c86f24a163c2e3e50861a2e2027751190db699ccb`; one attempt, fresh private target, Node 24.18.0, Arborist 9.4.0, config 10.8.1, empty user/global/project config, scripts ignored, audit off, default force/strict/legacy/omit/include/engineStrict): PASS. The private target resolved only `@mageyuki/opencode-subagent-statusline` 0.7.1. The optional UI, API, and keymap packages were not installed.
- An earlier candidate (before the devDependency correction) also installed in isolation with the same result. That earlier result is superseded by candidate C.
- Actual-host CLI smoke: PENDING. The local explicit server (`127.0.0.1:49374`) rejected an unauthenticated request with a password requirement. No credential or environment secret was read, and no other endpoint or client was used. No normal interactive host was started.

## Verification limits

- Not claimed: publication readiness, actual-host qualification, interactive TUI behavior, normal-TUI matrix, runtime or network success, or any OpenTUI `0.6` compatibility.
- The isolated install proves package resolution only, not runtime rendering.
