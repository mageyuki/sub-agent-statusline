import { dirname, join } from "node:path";
import { renderStatusLine } from "./render.js";
import { resolveStatePath, resolveTextPath, saveState, saveStatusText, type StatuslineState } from "./state.js";

export interface V2SnapshotPaths { statePath: string; textPath: string }
export function resolveV2SnapshotPaths(): V2SnapshotPaths {
  const override = process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE;
  const statePath = override?.trim() ? resolveStatePath() : join(dirname(resolveStatePath()), "v2", "state.json");
  return { statePath, textPath: resolveTextPath(statePath) };
}
export interface V2SnapshotWriter {
  enqueue(state: StatuslineState): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export function createV2SnapshotWriter(input: V2SnapshotPaths & {
  onIssue: (issue: "snapshot-failed") => void;
}): V2SnapshotWriter {
  let disposed = false;
  let pending: StatuslineState | undefined;
  let inFlight: Promise<void> | undefined;
  const options = { shouldCommit: () => !disposed };

  function drain() {
    if (inFlight || disposed || !pending) return;
    // Defer to coalesce same-turn events; thereafter there is just one I/O owner.
    inFlight = Promise.resolve().then(async () => {
      while (!disposed && pending) {
        const state = pending;
        pending = undefined;
        try {
          await saveState(input.statePath, state, options);
          if (!disposed) await saveStatusText(input.textPath, renderStatusLine(state), options);
        } catch {
          if (!disposed) input.onIssue("snapshot-failed");
        }
      }
    }).finally(() => {
      inFlight = undefined;
      drain();
    });
  }
  async function flush() {
    while (inFlight) await inFlight;
  }
  return {
    enqueue(state) {
      if (disposed) return;
      // saveState refreshes derived fields in place. Never give it live monitor state.
      pending = structuredClone(state);
      drain();
    },
    flush,
    async dispose() {
      disposed = true;
      pending = undefined;
      // The guard cancels before rename when possible. A rename already issued to the
      // OS is awaited too; no retired write can finish after this promise resolves.
      await flush();
    },
  };
}
