# Overview

## V1 and V2 scope

The same root and `/tui` entry lazily select the host adapter, preserving ID `subagent-statusline.tui`. V1 support remains `>=1.14.50 <2` (qualification targets 1.14.50 and 1.18.29); the V2 target is **2.0.11**, not every V2 release. `/runtime` is experimental and V1-only.

V2 keeps the sidebar/home summary and focused-list controls. Its public child-execution data supplies cumulative **input + output usage**, optional summaries/model data, and interruption/freshness feedback; it does not infer context occupancy or scrape V1 SQLite/logs. Snapshots keep the existing format/retention but default to a `v2` subdirectory. See [installation](02-installation-and-usage.md) for V2 `cli.json` and local-directory registration.

The detailed legacy event/wrapper pipeline below describes **V1**. Its integration now lives in `src/tui-v1.tsx`, while presentation is shared in `src/tui-view.tsx`; `src/tui.tsx` is only the lazy public bridge.

`opencode-subagent-statusline` is an OpenCode TUI plugin that shows subagent activity inside the interface: running subagents, completed subagents, failures, elapsed time, and token/context usage when OpenCode exposes that information.

The core idea is simple:

> When work is delegated to subagents, the plugin keeps that activity visible so users do not have to reconstruct it from events, logs, or child sessions.

## Problem it solves

OpenCode can run delegated work through child sessions or through tools such as `task` and `delegate`. That is useful, but it creates a visibility problem: activity can be split across session events, message parts, and technical wrappers.

Without a dedicated view, it is hard to answer questions like:

- Is a subagent still running?
- Did it finish successfully or fail?
- Which child session is the real one?
- How long has it been running?
- How much context did it use?
- Am I seeing real work or a duplicated technical wrapper?

This plugin collects those signals and turns them into a compact TUI view.

## What it shows

In the TUI, the plugin can show:

- running subagents;
- recently completed subagents;
- failed subagents;
- estimated duration;
- token and context usage when available;
- an aggregate summary on the home screen;
- navigation to the real child session when a navigable `sessionID` exists.

## Public entrypoints

The package exposes these entrypoints:

| Entrypoint                             | Source         | Primary use                                                                                |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `opencode-subagent-statusline`         | `src/tui.tsx`  | Main TUI plugin. Recommended path for users.                                               |
| `opencode-subagent-statusline/tui`     | `src/tui.tsx`  | Explicit alias for the TUI plugin.                                                         |
| `opencode-subagent-statusline/runtime` | `src/index.ts` | Advanced runtime/file-based plugin. Processes events and writes `state.json`/`status.txt`. |

The current README focuses on the TUI mode, which is the package's main experience.

## High-level flow

```txt
OpenCode event
  -> src/events.ts
  -> src/state.ts
  -> src/render.ts
  -> src/tui-v1.tsx (via the public bridge) or src/index.ts
  -> sidebar / home footer / status.txt
```

Step by step:

1. **OpenCode emits events**
   - For example: `session.created`, `session.status`, `message.part.updated`.

2. **The plugin extracts subagent evidence**
   - `src/events.ts` interprets session events, subtasks, and tool wrappers.

3. **Internal state is updated**
   - `src/state.ts` stores children, statuses, timing, tokens, and counters.

4. **Rendering decides what is visible**
   - `src/render.ts` collapses duplicates, filters old rows, and builds aggregate text.

5. **The TUI displays the information**
   - `src/tui-v1.tsx` registers V1 slots, commands, navigation, hydration, and reconciliation.

## Key concept: not every event is a real execution

This is the most important concept in the project.

OpenCode can represent delegated work in several ways:

| Internal source | What it represents                                          | Counts as execution      |
| --------------- | ----------------------------------------------------------- | ------------------------ |
| `session`       | A real OpenCode child session.                              | Yes, once.               |
| `subtask`       | A synthetic row derived from message parts.                 | May count provisionally. |
| `tool`          | A technical wrapper for tools such as `task` or `delegate`. | No.                      |

The plugin therefore separates three concepts:

1. **Stored state**: everything the plugin knows.
2. **Visible rows**: what should be shown after duplicate collapse.
3. **Executed total**: the semantic count of real work.

A visible row does not always equal one execution. A `tool:*` wrapper can provide status evidence, but it must not inflate `totalExecuted`.

## Defensive design

The plugin works with event shapes that can vary by OpenCode version, delegation type, and event timing.

That is why the design is conservative:

- ambiguous correlations are not forced;
- multiple possible session IDs are not guessed;
- old running sessions are not blindly closed;
- missing token/context information is safely omitted;
- auxiliary state/debug write failures should not crash OpenCode.

This strategy appears throughout the code and tests as **fail-closed** behavior.

## What is tested

The deterministic core has strong test coverage for:

- event parsing;
- state transitions;
- counters and deduplication;
- text rendering;
- conservative reconciliation;
- basic command/keybinding registration;
- runtime plugin persistence.

Native tests cover shared rendering and adapter lifecycle behavior. Actual packed-host interactions are qualified separately in isolated OpenCode instances; they are not part of ordinary unit CI. Synthetic qualification does not replace genuine execution acceptance in the user's normal TUI.

## Next reading

Continue with:

- [Architecture](./03-architecture.md)
- [Event flow](./04-event-flow.md)
- [State model and counters](./05-state-model-and-counters.md)
- [Rendering and deduplication](./06-rendering-and-deduplication.md)
