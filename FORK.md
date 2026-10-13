# Fork provenance: @mageyuki/opencode-subagent-statusline

Status:

- `0.7.0` is the published first release of the scoped name.
- `0.7.1` is an unpublished candidate. Its frozen-lockfile check passes and its isolated install passed. Its actual-host CLI smoke is pending: the local explicit server requires a password, and no authenticated path has been supplied. It is not publishable yet.

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
- `pnpm-lock.yaml`: NOT byte-identical to the original pin any more. The `0.7.1` candidate adds the closure needed for the keymap guard (see below). All old package versions and integrities are preserved. Existing snapshots are unchanged except the `@opencode-ai/plugin` 1.16.2 snapshot, which is re-keyed with a keymap context suffix and gains an optional keymap edge; its importer line changes only its peer-context suffix. The version stays `1.16.2`.
- Existing peer ranges and the `@opencode-ai/*` / `@opencode/*` host-peer ranges.
- Runtime `dist/` (9 files): byte-identical to the `0.7.0` package artifact (verified at packaging).

`FORK.md` is not part of the published package (`package.files` is `dist`, `assets`, `README.md`).

## 0.7.1 candidate

Relative to `484a38ee`:

- `package.json` version `0.7.1`.
- `peerDependenciesMeta` optional flags for `@opentui/core`, `@opentui/keymap`, `@opentui/solid`, and `solid-js`, alongside the existing flags.
- A new peer `@opentui/keymap` with range `>=0.4.0 <0.6`. It bounds the optional legacy-SDK keymap recursion to the already supported OpenTUI `<0.6` family. It is not a runtime import or dependency, and it is not a claim of `0.6` compatibility.
- Existing peer ranges are unchanged. No source, runtime, asset, or license change.
- Lockfile: a narrow sync adding the root specifier for `@opentui/keymap` (`>=0.4.0 <0.6`, resolved to `0.5.17`) and the closure it needs: `@opentui/keymap@0.5.17`, `@opentui/core@0.5.17` and its eight platform packages (all at `0.5.17`), plus the snapshot entries for them. The `@opencode-ai/plugin` 1.16.2 snapshot is re-keyed with a keymap context suffix and gains an optional keymap dependency. No existing version or integrity changed, and no direct dev pin changed.

## Failure chain behind the change

- The published `0.7.0` failed a private isolated install (Node 24.18.0, npm Arborist 9.4.0, config 10.8.1, scripts disabled, no audit, default resolution) with ERESOLVE on `@opentui/solid` 0.6.3 against `>=0.4.0 <0.6`.
- A trace of the optional-only candidate (UI peers optional, no keymap guard) showed the cause: optional `@opencode-ai/plugin` (the peer range resolved to 1.19.0 in that isolated tree) → optional `@opentui/keymap` (`>=0.4.5`) resolved to 0.6.3 → peer-optional `@opentui/solid` pinned exactly to 0.6.3. The same ERESOLVE remained. Optional flags alone did not fix it.
- The keymap guard addresses that chain. The live-host root cause is not separately established.

## Incident record

- During validation, a non-frozen pnpm run (triggered implicitly by `pnpm build`/`pnpm exec`) rewrote `pnpm-lock.yaml` beyond the keymap guard. The broader rewrite was reverted from the committed bytes; nothing was committed or published.
- The captured rewrite was then parsed against the committed lock. Only the narrow closure above was applied, with `patch`. A structural check confirmed that every existing package entry and every pinned version and integrity is unchanged. Existing snapshots are unchanged except the `@opencode-ai/plugin` 1.16.2 re-key and its optional keymap edge. Each new entry's integrity matches the public registry's metadata for the same name and version.
- The earlier note that `@opencode-ai/plugin` was bumped is incorrect. Its version stays `1.16.2`; its snapshot was re-keyed with a keymap context suffix and gained an optional keymap edge.

## Verification of the 0.7.1 candidate

- Package fixture (existing 7 cases, extended): RED on the optional-only manifest (missing `@opentui/keymap` in the peer key set). GREEN after the metadata and lock change, 7/7. The literal guard-range expectation's own RED was not separately shown, because the key-set assertion failed first.
- Frozen lockfile: `pnpm install --frozen-lockfile --ignore-scripts --offline` PASS, exit 0, and the lock stayed byte-identical.
- Build: `pnpm build` PASS. `pnpm typecheck` PASS. `tsc --noEmit -p tsconfig.test.json` PASS.
- Isolated install of the keymap-guarded candidate (one attempt, private target, no registry metadata for the candidate): PASS. The private target resolved `@mageyuki/opencode-subagent-statusline` 0.7.1, and the optional UI, API, and keymap packages were not installed.
- Actual-host CLI smoke: PENDING. The local explicit server (`127.0.0.1:49374`) rejected an unauthenticated request with a password requirement. No credential or environment secret was read, and no other endpoint or client was used. No normal interactive host was started.

## Verification limits

- Not claimed: publication readiness, actual-host qualification, interactive TUI behavior, normal-TUI matrix, runtime or network success, or any OpenTUI `0.6` compatibility.
- The isolated install proves package resolution only, not runtime rendering.
