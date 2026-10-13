# Releasing

Stable publication is explicit and tag-gated. Merging ordinary changes to `main` runs CI but never publishes to npm.

## Quick Path

1. Invoke the project release skill with execution intent, such as `prepare a release`.
2. Reconcile any disagreement between `package.json`, stable tags, and npm before selecting a bump category.
3. Confirm the recommended major, minor, or patch category. The skill calculates the exact version and prepares a release PR on a branch.
4. Merge the reviewed release PR through the repository's normal PR protections.
5. After push CI succeeds for the merged SHA, give one immediate approval whose effect is explicit: creating and pushing annotated `vX.Y.Z` for that exact SHA will trigger automated npm publication and GitHub Release creation.
6. Do not give a second post-tag publication approval. Confirm the workflow reports the exact npm package and GitHub Release evidence.

## Release Gates

| Gate | Required evidence |
| --- | --- |
| Version | Stable tag format and exact equality with committed `package.json` version |
| Candidate | Annotated tag targets the current `origin/main` SHA; a stale tag fails closed |
| CI | A completed successful push run of `.github/workflows/ci.yml` for that exact SHA |
| GitHub Release state | Before npm publication, the API must prove the release is absent or is an existing non-draft, non-prerelease release whose tag and target SHA exactly match the candidate; unknown or conflicting state fails closed |
| Package | After preflight, the workflow publishes the exact `pnpm pack` tarball with the existing `NPM_TOKEN` and provenance enabled |
| Recovery | An existing npm version is accepted only when its registry integrity matches the exact local tarball; existing tags and incompatible GitHub Releases are never moved or mutated |
| Release notes | After npm publication or identity-matching npm recovery, notes are created only when preflight proved the GitHub Release absent; compatible existing releases are skipped and then verified |

The stale-tag policy is intentionally strict: the tag target must equal `origin/main` when the release workflow starts. If `main` advances, create a new tag only after CI succeeds for the new candidate; never retarget the old tag.

## One-Time Reconciliation

This repository publishes under the scoped name `@mageyuki/opencode-subagent-statusline`, a new npm package distinct from upstream `opencode-subagent-statusline` (whose 1.x tags and npm versions are not this package's history). The scoped line's first published release is `0.7.0`; `package.json` carries `0.7.1`; that version is published only through the one-off exception below. Before tagging a version, confirm that version is absent from npm and from this repository's stable tags; the release skill and workflow fail closed rather than choosing a version silently.

## 0.7.1 One-Off Manual Publication (authorized exception)

This exception applies to `0.7.1` only. The tag-gated workflow above stays the path for every future release.

- Scope: publish the exact final `0.7.1` tarball once, as `latest`. Create no annotated tag and no GitHub Release for this release. Merging to `main` never publishes.
- Preconditions: the reviewed latest PR head has successful CI; the merged `main` release tree exactly matches that reviewed head; the tarball is packed from that exact `main` commit. If a `main` push CI run starts automatically, record it; this document requests no additional test gate or local full suite. The user's authorization is the approval for this exception, so no second approval gate applies.
- Tarball: `tgz=./mageyuki-opencode-subagent-statusline-0.7.1.tgz`, produced by `pnpm pack` from the final `main` commit.
- Read-only checks: `npm whoami --registry=https://registry.npmjs.org/` succeeds (credentials are handled internally by the existing npm login), and `npm view @mageyuki/opencode-subagent-statusline@0.7.1 version` reports not found. If the version already exists, stop. Never republish the same version.
- Publish (operator command):

  ```sh
  npm publish "$tgz" --access=public --tag=latest --registry=https://registry.npmjs.org/ --browser=false --provenance=false
  ```

- Authentication: the existing npm client manages registration privately. The maintainer may complete a local TTY, web or one-time-password prompt. Do not copy secrets into the repository, evidence, logs, PRs or assistant sessions, and never ask the assistant for an OTP or token. This process changes no auth settings; existing `.npmrc` and environment configuration are used as they are. `--provenance=false` means this manual publish carries no provenance; the automated workflow remains the provenance path.
- After publishing: `npm view @mageyuki/opencode-subagent-statusline@0.7.1 dist.integrity` must equal the integrity recorded when `$tgz` was packed.

## Recovery

Rerunning an unchanged tag is safe only when all identity checks pass before npm publication. A matching npm integrity with an absent GitHub Release can continue to release-note creation. An existing compatible stable GitHub Release is skipped and verified. Any mismatched integrity, draft or prerelease release, target-SHA mismatch, moved tag, stale candidate, or unknown registry/API error stops before npm publication.
