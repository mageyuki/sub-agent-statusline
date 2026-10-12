# Fork provenance: @mageyuki/opencode-subagent-statusline

Status: prepared, unpublished `0.7.0` candidate. Not published to npm. Not qualified on the actual host.

## Baselines

- Original V2 pin (source): `a186ba9791931ccf148581a8cf6d20761882bd67`
- New runtime/source baseline (`main`): `646dea13ef48ec4eb0df30d75f6eff54ebfb41e7`
- Final source commit: supplied by the Controller handoff, not recorded here.

## Changes from the original pin

- Constant organization only, with unchanged values: `src/internal-policy.ts` (from `main`) holds internal runtime policy constants. Consumers: `src/logs.ts`, `src/state.ts`, `src/tui-v1.tsx`, `src/tui-v2-focus.ts`, `src/tui-v2-state.ts`.
- These are not topic behavior or public API changes. `package.json` exports and the public entry set are unchanged.
- Package identity is scoped: `@mageyuki/opencode-subagent-statusline`, with the fork description and repository metadata.
- Tests keep both the scoped identity check and the `main` peer/engine checks in `test/package.integration.test.ts`.

## Unchanged

- `assets/` (byte-identical to the original pin and `main`).
- `LICENSE` and `pnpm-lock.yaml` (byte-identical to the original pin and `main`).
- V2 functional contracts and the `@opencode-ai/*` / `@opencode/*` host-peer ranges.

`FORK.md` is not part of the published package (`package.files` is `dist`, `assets`, `README.md`).

## Verification limits

Source and package checks only. No live backend, host, or server run. Not claimed: host qualification, publication, or runtime/network success.
