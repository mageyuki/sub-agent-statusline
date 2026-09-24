# Subagent Monitor

![Subagents Monitor banner](https://raw.githubusercontent.com/Joaquinvesapa/sub-agent-statusline/main/assets/subagents_monitor_banner.webp)

See delegated work without leaving OpenCode. **Subagent Monitor** is an MIT-licensed OpenCode TUI sidebar plugin that keeps running, completed, and failed subagents visible, with elapsed time and token/context usage when OpenCode provides it.

[![npm version](https://img.shields.io/npm/v/opencode-subagent-statusline?style=flat-square)](https://www.npmjs.com/package/opencode-subagent-statusline)
[![monthly npm downloads](https://img.shields.io/npm/dm/opencode-subagent-statusline?style=flat-square)](https://www.npmjs.com/package/opencode-subagent-statusline)
[![GitHub stars](https://img.shields.io/github/stars/Joaquinvesapa/sub-agent-statusline?style=flat-square)](https://github.com/Joaquinvesapa/sub-agent-statusline)
[![license](https://img.shields.io/github/license/Joaquinvesapa/sub-agent-statusline?style=flat-square)](LICENSE)

## Install

This compatibility build preserves **OpenCode V1 `>=1.14.50 <2`** and targets **V2 2.0.11**, not arbitrary V2 releases. V1 qualification covers 1.14.50 and 1.18.29 separately; package installation alone is not actual-host qualification. Node remains `>=22.13`.

### V2 2.0.11

Register the TUI in global `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`), **not** the server plugin list. An illustrative **new** configuration for a reviewed local build is:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/reviewed-artifact/dist"]
}
```

The local directory must directly contain `tui.js` and its adjacent adapters; neither the package root nor a direct `tui.js` file is the V2 registration form. Keep the complete installed package/dependencies. For a published release containing this dual bridge, the named-package form is `"plugins": ["opencode-subagent-statusline"]`; root and `/tui` exports are unchanged. These instructions do not mean this development build has been published to npm.

Add only this entry to your existing configuration, preserving unrelated plugins/settings. Register one `subagent-statusline.tui` identity. Configuration can reload immediately: first keep a restrictive-permission backup and a known working artifact for rollback. Remove only the added entry to roll back, or restore the backup only if no other edits occurred. Any normal-TUI restart is user-controlled.

### V1

Add the package to your OpenCode V1 TUI configuration:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-subagent-statusline"]
}
```

The configuration usually lives at:

```txt
~/.config/opencode/tui.json
```

Restart OpenCode after saving the file. The package is published as `opencode-subagent-statusline` and requires Node `>=22.13`.

## Why Subagent Monitor?

Delegating work is powerful, but child sessions can disappear into the background. Without a visible status surface, you have to guess:

- Is the review agent still running?
- Did the test agent finish?
- Which child session failed?
- How much context did a subagent use?

Subagent Monitor restores that visibility inside OpenCode, so you can keep working while still knowing what your delegated agents are doing.

## What you get

The sidebar shows:

- running subagents;
- recent completed subagents;
- failed subagents;
- elapsed time;
- token/context usage when available.

When subagent activity is active, the plugin also adds a compact summary to the home/footer area.

## Gentle AI integration

[Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) offers Subagent Monitor as an optional OpenCode community plugin. Select and install it through Gentle AI to add the selected plugin to OpenCode's `tui.json`, or install this package directly using the configuration above.

This integration is optional. Subagent Monitor remains an independently installable OpenCode plugin.

## Screenshots

Full OpenCode context with demo content in Spanish:

![Subagent Monitor in the full OpenCode view](https://raw.githubusercontent.com/Joaquinvesapa/sub-agent-statusline/main/assets/opencode_full.webp)

Focused sidebar view:

![Subagent Monitor focused sidebar](https://raw.githubusercontent.com/Joaquinvesapa/sub-agent-statusline/main/assets/opencode_sidebar.webp)

## Keyboard navigation

Run `Subagents: Focus sidebar list` from the OpenCode command palette, or press `Alt+B`, to focus the subagent sidebar list without using the mouse. List navigation shortcuts are handled only while the sidebar list is focused.

| Shortcut | Action |
| --- | --- |
| `Alt+B` | Toggle focus between the subagent sidebar list and the prompt. |
| `j` / `ArrowDown` | Move selection to the next visible subagent. |
| `k` / `ArrowUp` | Move selection to the previous visible subagent. |
| `Enter` | Open the selected subagent session. |
| `c` | Toggle retained completed history in the sidebar. |
| `h` / `ArrowLeft` | Collapse the subagent section. |
| `l` / `ArrowRight` | Expand the subagent section. |
| `Esc` | Leave list focus mode and return to the prompt. |

Opening a selected session is a no-op when there is no visible or navigable subagent.

Click `Σ` in the sidebar aggregate row to toggle completed history with the mouse. The toggle is not persisted; it resets when OpenCode or the plugin is reloaded. Completed history is bounded retained history, not a full database: terminal rows are kept for up to 3 days with a 1,500-row cap, and rows already pruned from state are not restored.

When a child session is opened from the sidebar, return with OpenCode `Up` (`session_parent` on V1, `session.parent` on V2) to type in the parent prompt. V2 leaves focus to the newly mounted host editor rather than refocusing an old editor or the list. Dialogs and hidden sidebars must not capture list input; `Alt/Option+Left` retains host word navigation.

<details>
<summary>Stable 1.x public contract</summary>

For 1.x releases, the stable user-facing contract is:

- npm package name: `opencode-subagent-statusline`;
- TUI plugin entrypoints: `opencode-subagent-statusline` and `opencode-subagent-statusline/tui`;
- OpenCode V1 `tui.json` or V2 `cli.json` TUI configuration;
- visible sidebar and home/footer behavior;
- command palette entry, `Alt+B`, and focused-list navigation;
- local privacy and persistence behavior described in this README;
- Node, peer dependency, and install contract declared in `package.json`.

Experimental or internal surfaces may change in 1.x without a SemVer-major bump:

- `opencode-subagent-statusline/runtime`, a **V1-only** diagnostic/file-output experiment, not a V2 requirement;
- diagnostic environment variables;
- exact `state.json` schema and `status.txt` format;
- internal source modules and source-level exports.

Use the TUI plugin entrypoints for normal OpenCode usage.

</details>

## Documentation

For deeper installation, architecture, event-flow, state, rendering, TUI, configuration, testing, and troubleshooting details:

- [English documentation](docs/en/00-index.md)
- [Documentación en español](docs/es/00-indice.md)
- [Testing strategy](docs/testing.md)

## Troubleshooting

### The plugin does not show up

Check OpenCode logs:

```sh
grep -n "subagent-statusline\|failed to load tui plugin" ~/.local/share/opencode/log/*.log
```

For V1, restart OpenCode after changing `tui.json`. For V2, check the global `cli.json` and any `OPENCODE_CLI_CONFIG_CONTENT` override; local registration must point to the directory containing `tui.js`. V2 logs normally use `~/.local/share/opencode/log/opencode.log`. Do not restart a shared service just to reload this TUI plugin.

### I installed a new version but OpenCode still behaves like the old one

OpenCode may be using a cached package. Try clearing the cached package directory under:

```txt
~/.cache/opencode/packages/
```

Then restart OpenCode.

### Token/context usage is missing

OpenCode event payloads vary by host. V1 retains its existing token/context display. V2 displays cumulative **input + output usage**, not context occupancy; it does not infer a context percentage. Summary/model fields are optional. `Interrupted` and `Status may be stale` are feedback within the existing three states, not new persistent statuses.

## Local privacy and persistence

The plugin persists a local JSON state file and `status.txt` snapshot under `XDG_RUNTIME_DIR` or the system temp directory by default. Those files can include OpenCode-derived subagent titles and summaries, which may contain short fragments derived from prompts or task descriptions. Files are written best-effort with owner-only permissions and atomic temp-file replacement where Node and the host filesystem support them.

V2 uses a `v2` subdirectory under the existing default instance directory, with the same `state.json`/`status.txt` format and terminal retention (3 days, 1,500 rows; active children are not capped). It hydrates the connected host, not saved V1 state. `OPENCODE_SUBAGENT_STATUSLINE_STATE` remains an **exact-path override**: use a distinct path for each concurrent V1/V2/runtime writer. Treat it as trusted local configuration.

For token/context backfill, the **V1 TUI only** reads recent local OpenCode SQLite/log data. V2 uses public connected-host session/event/cache APIs, including remote hosts; it does not scrape databases/logs or persist raw events, messages, tool output, credentials, or exception bodies. V1 debug-log/DB/stale-fallback options and runtime startup-preservation options do not acquire those semantics on V2.

<details>
<summary>Development and testing</summary>

Use Node `>=22.13` and pnpm `11.2.2`. Install dependencies with lifecycle scripts disabled:

```sh
pnpm install --ignore-scripts
```

Build the plugin:

```sh
pnpm build
```

Test a local **V1** TUI build by pointing OpenCode directly at `dist/tui.js` (V2 uses the directory form above):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
}
```

`src/tui.tsx` is a host-runtime-free lazy bridge built without bundling. Separate `tui-v1.js`/`tui-v2.js` adapters bundle the shared view using Solid `universal` mode; host API, Solid, OpenTUI and theme runtimes remain external. The build cleans `dist` once before all configurations.

Package entrypoints:

```txt
opencode-subagent-statusline          -> TUI plugin
opencode-subagent-statusline/tui      -> TUI plugin
opencode-subagent-statusline/runtime  -> experimental/diagnostic runtime mode
```

Useful commands:

```sh
pnpm build
pnpm typecheck
pnpm exec tsc --noEmit -p tsconfig.test.json
pnpm test
pnpm test:package
pnpm test:watch
pnpm test:coverage
pnpm pack --dry-run
```

`test:package` builds first, packs the artifact and checks its parsed runtime/declaration graph. Ordinary tests exclude that file so they never consume stale `dist`. Both Vitest configurations prohibit `.only` tests.

The baseline CI lane remains Node **22.13**. Ordinary Node 22/24 skips native cases only when `node:ffi` is unavailable; the required native lane uses an isolated official Node **26.4.0** and must report **zero skips**. Select that binary as `node`, without replacing your normal runtime, and enable FFI in parent and workers:

```sh
node --experimental-ffi node_modules/vitest/vitest.mjs run --execArgv=--experimental-ffi
```

Neither native Vitest nor synthetic data substitutes for actual packed-host interaction checks or genuine normal-TUI execution acceptance. See the [development guide](docs/en/09-development-and-testing.md) for exact peer combinations and the host matrix.

</details>

<details>
<summary>Security hardening for maintainers</summary>

Recommended local npm/pnpm hygiene, following guidance from Gentle AI and Liran Tal:

- install project dependencies with lifecycle scripts disabled when possible, for example `pnpm install --ignore-scripts`;
- consider setting user-level `ignore-scripts=true` for npm/pnpm and temporarily opt in only when a trusted package needs scripts;
- enable dependency age/cooldown policies where supported, for example `npm config set min-release-age 3` or equivalent Renovate/Dependabot cooldowns;
- block or review git, tarball, URL, and other exotic dependency specs, for example `npm config set allow-git none` where supported;
- optionally screen new packages with tools such as `npq` or Socket Firewall before adding them.

These are maintainer/developer controls, not runtime enforcement by this plugin.

Release maintainers should keep the repository `NPM_TOKEN` secret restricted, retain npm provenance, require npm 2FA on maintainer accounts, and protect the release branch in GitHub. See the [release process](docs/releasing.md) for the tag and recovery gates.

</details>

## Community and releases

- [npm package](https://www.npmjs.com/package/opencode-subagent-statusline)
- [GitHub repository](https://github.com/Joaquinvesapa/sub-agent-statusline)
- [Releases](https://github.com/Joaquinvesapa/sub-agent-statusline/releases)
- [Issues](https://github.com/Joaquinvesapa/sub-agent-statusline/issues)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
