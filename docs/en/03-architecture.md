# Architecture

## Dual-host entry and shared view

```txt
root / tui -> dist/tui.js (src/tui.tsx, no bundled host runtime)
  tui(api, options, meta) -> lazy tui-v1.js -> existing V1 events/fallback
  setup(context)         -> lazy tui-v2.js -> public V2 execution/cache data
                              both -> shared tui-view.tsx + state/render helpers
runtime -> dist/index.js (experimental, V1-only)
```

The bridge never tries the other host on initialization failure. Each bundled adapter keeps host API, theme, Solid and OpenTUI runtimes external. `@opencode/client` is type-only. Build cleans once before parallel configurations and ships all relative runtime/declaration references. V2 owns focus, request generations and serialized snapshots per setup; cleanup invalidates pending work and awaits the writer. Theme mapping uses eight roles, including distinct `backgroundPanel` and `backgroundElement`; storage holds only `{ enabled, expanded }` preferences.

The pipeline and integration details below describe **V1**, now in `src/tui-v1.tsx` with shared rendering in `src/tui-view.tsx`.

The plugin is organized around a pipeline: receive OpenCode events, normalize them into internal state, deduplicate technical representations, and render a useful TUI view.

```txt
OpenCode
  ├─ session events
  ├─ message events
  └─ part/tool-call events
        ↓
src/events.ts
        ↓
src/state.ts
        ↓
src/render.ts
        ↓
┌──────────────────────┬──────────────────────┐
│ src/tui-v1.tsx       │ src/index.ts          │
│ Main TUI plugin      │ Runtime plugin        │
│ Sidebar / footer     │ state.json/status.txt │
└──────────────────────┴──────────────────────┘
```

## Module map

| File | Responsibility |
| --- | --- |
| `src/tui.tsx` | Host-runtime-free lazy public bridge. |
| `src/tui-v1.tsx` | V1 slots, hydration, fallback, navigation and lifecycle. |
| `src/tui-v2.tsx` | V2 slots, typed data, keymap/focus and owned cleanup. |
| `src/tui-view.tsx` | Shared sidebar/home presentation and view controller. |
| `src/index.ts` | Runtime/file-based plugin: listens to events, persists state, and writes `status.txt`. |
| `src/events.ts` | Converts OpenCode events into internal state mutations. |
| `src/state.ts` | Defines the data model, counters, persistence, and mutation helpers. |
| `src/render.ts` | Formats rows, collapses duplicates, filters visibility, and builds statusline text. |
| `src/reconcile.ts` | Normalizes OpenCode statuses and safely closes stale `running` cases. |
| `src/tui-commands.ts` | Registers commands and keybindings, especially `Alt+B`. |
| `src/*.test.ts` | Unit tests for deterministic core behavior. |
| `test/index.integration.test.ts` | Runtime plugin integration tests for filesystem persistence. |

## Entrypoints

### TUI plugin

Public source: `src/tui.tsx`; the following legacy responsibilities belong to `src/tui-v1.tsx` and the shared `src/tui-view.tsx`, not the bridge itself.

This is the package's main entrypoint:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
```

Main responsibilities:

- register the TUI plugin with id `subagent-statusline.tui`;
- mount the UI with Solid/OpenTUI;
- listen to relevant OpenCode events;
- render the subagent sidebar;
- render a bottom home summary;
- register commands and shortcuts;
- hydrate existing subagents when navigating between sessions;
- reconcile stale `running` items;
- persist auxiliary state snapshots.

### Runtime plugin

Source: `src/index.ts`

Published as:

```txt
opencode-subagent-statusline/runtime
```

This is a lower-level mode. It does not render the TUI sidebar. Instead, it:

1. initializes state paths;
2. processes events;
3. saves `state.json`;
4. writes `status.txt` with text rendering.

It is useful for understanding the V1 project core because it uses the same event, state, and render pipeline without the visual `src/tui-view.tsx` layer.

## Internal model

The central state lives in `src/state.ts`.

Simplified shape:

```ts
type StatuslineState = {
  children: Record<string, ChildSessionState>;
  countedChildIDs: string[];
  totalExecuted: number;
  updatedAt: string;
};
```

Each child represents a unit of evidence related to delegated work:

```ts
type ChildSessionState = {
  id: string;
  parentID?: string;
  targetSessionID?: string;
  source?: "session" | "subtask" | "tool";
  status: "running" | "done" | "error";
  title?: string;
  summary?: string;
  agent?: string;
  startedAt?: string;
  endedAt?: string;
  tokenState?: ChildTokenState;
};
```

The detailed model is covered in [State model and counters](./05-state-model-and-counters.md), but the base rule is:

> State stores evidence. Rendering decides what is visible. Counters decide what was real execution.

## Sources: session, subtask, and tool

The plugin must distinguish where each work item came from.

| Source | Typical origin | Use |
| --- | --- | --- |
| `session` | OpenCode `session.*` events with a real child session. | Strongest source. Counts as real execution. |
| `subtask` | Message parts describing a subtask. | Early/provisional fallback. |
| `tool` | Tool calls such as `task` or `delegate`. | Status evidence; does not count as execution. |

This split exists because OpenCode may first report a technical wrapper and reveal the real session later, or expose incomplete data across multiple events.

## Event pipeline

`src/events.ts` receives OpenCode events and decides whether they should affect state.

| Event | Possible meaning |
| --- | --- |
| `session.created` | A real child session appeared. |
| `session.updated` | A session changed. |
| `session.status` | A normalized session status changed. |
| `session.idle` | The session became idle, usually `done`. |
| `session.error` | The session failed. |
| `message.updated` | May contain completion evidence for subtasks. |
| `message.part.updated` | May represent subtasks or `task`/`delegate` wrappers. |

`events.ts` does not render. Its job is to turn variable signals into consistent `StatuslineState` mutations.

## State and counters

`src/state.ts` owns important invariants:

- create or update running children;
- mark children as `done` or `error`;
- merge title, summary, agent, target, and token details;
- refresh durations and derived fields;
- persist and load state;
- prune old terminal children;
- keep `totalExecuted` free of duplicates.

Critical rules:

- `source: "tool"` wrappers do not increment counters;
- real sessions count exactly once;
- subtasks may count as fallback;
- when a real session appears later, counts reconcile to that session;
- state loaded from disk is normalized to avoid duplicate identities.

## Rendering

`src/render.ts` does not simply print `state.children`.

Before showing anything, it:

1. sorts by priority/recency;
2. collapses duplicates;
3. merges useful session data into synthetic rows when appropriate;
4. filters old `done` rows;
5. keeps errors and running items visible;
6. builds the aggregate summary.

That is why there can be more children in state than visible rows in the UI.

## TUI runtime

`src/tui-v1.tsx` integrates the legacy OpenCode runtime concerns; the shared visual layer lives in `src/tui-view.tsx`.

It handles initialization, visual slots, the sidebar, hydration, reconciliation, token/context best-effort loading, navigation, prompt focus preservation, and lifecycle cleanup.

The sidebar shows subagents related to the current session only. Home summary and text/status-file rendering remain global across sessions. Rows are navigable only when a real `ses_*` target is known.

## Reconciliation

`src/reconcile.ts` contains helpers for interpreting OpenCode statuses and avoiding unsafe closures.

| OpenCode | Internal status |
| --- | --- |
| `busy`, `running`, `pending`, `queued`, `working`, `compacting`, `retry` | `running` |
| `idle`, `done`, `completed`, `complete`, `success`, `succeeded` | `done` |
| `error`, `failed`, `failure`, `cancelled`, `canceled`, `aborted` | `error` |

Unknown statuses are treated as inconclusive instead of guessed.

## Commands and keybindings

`src/tui-commands.ts` registers TUI commands.

| Command | Action |
| --- | --- |
| `Subagents: Toggle sidebar section` | Enable or disable the subagent section. |
| `Subagents: Focus sidebar list` | Move focus to the subagent list. |
| `Subagents: Toggle completed history` | Toggle retained completed rows in the sidebar. |

Main shortcut:

```txt
Alt+B
```

The plugin prefers the modern keymap API when available and falls back to the legacy command API otherwise.

## Testing as architecture contract

Tests document design decisions as much as they verify code.

| Test | What it protects |
| --- | --- |
| `src/events.test.ts` | Event parsing, correlation, and fail-closed ambiguity handling. |
| `src/state.test.ts` | Counters, persistence, normalization, and source rules. |
| `src/render.test.ts` | Collapse, visibility, formatting, and aggregate summary. |
| `src/reconcile.test.ts` | Status normalization and conservative reconciliation. |
| `src/tui.test.ts` | Command/keybinding registration. |
| `test/index.integration.test.ts` | Runtime plugin, state files, and error tolerance. |

Verification boundary: native tests exercise the shared view and adapter lifecycles, including V1 slot ownership. Actual packed-host loading, keyboard precedence, navigation and cleanup are qualified separately; source tests alone do not establish host compatibility.

## Relevant configuration files

| File | Role |
| --- | --- |
| `package.json` | Package name, exports, scripts, peers, and release metadata. |
| `tsup.config.ts` | Dual build: runtime and TUI. |
| `tsconfig.json` | Base TypeScript config for source. |
| `tsconfig.test.json` | TypeScript config for tests. |
| `vitest.config.ts` | Vitest, coverage, and setup. |
| `.github/workflows/ci.yml` | PR and `main` push CI: typecheck, tests, audit, and package checks. |
| `.github/workflows/release.yml` | Stable tag-gated npm publication and GitHub Release notes. |

## Important design decisions

1. **Do not break OpenCode**: auxiliary operations are best-effort.
2. **Do not force ambiguous correlations**: missing evidence stays unresolved.
3. **Counters are semantic**: they count real work, not rows or events.
4. **The TUI hydrates historical data**: it does not rely only on live events.
5. **Tokens/context are optional**: they are shown only when evidence exists.

## Next reading

Continue with:

- [Event flow](./04-event-flow.md)
- [State model and counters](./05-state-model-and-counters.md)
- [Rendering and deduplication](./06-rendering-and-deduplication.md)
