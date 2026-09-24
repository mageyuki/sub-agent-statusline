import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createV2SnapshotWriter, resolveV2SnapshotPaths, type V2SnapshotWriter } from "./tui-v2-snapshot.js";
import { createEmptyState, resolveStatePath, upsertRunningChild } from "./state.js";
import { deferred } from "../test/helpers/v2-fixtures.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
const directories: string[] = [];
const writers: V2SnapshotWriter[] = [];
afterEach(async () => {
  await Promise.all(writers.splice(0).map(writer => writer.dispose()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "subagent-v2-snapshot-")); directories.push(dir);
  const statePath = join(dir, "v2", "state.json");
  const textPath = join(dir, "v2", "status.txt");
  const onIssue = vi.fn();
  const writer = createV2SnapshotWriter({ statePath, textPath, onIssue }); writers.push(writer);
  return { dir, statePath, textPath, onIssue, writer };
}
function snapshot(title: string) {
  const state = createEmptyState();
  upsertRunningChild(state, { id: "ses_child", parentID: "ses_parent", title, source: "session" });
  return state;
}
async function writeBarrier() {
  const reached = deferred<void>(); const release = deferred<void>();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await actual.writeFile(...args); reached.resolve(); await release.promise;
  });
  return { reached, release };
}

describe("V2 snapshot ownership", () => {
  it("uses a V2 subdirectory by default but preserves an explicit exact-path override", () => {
    delete process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE;
    process.env.XDG_RUNTIME_DIR = "/tmp/opencode/fixture-runtime";
    process.env.OPENCODE_SUBAGENT_STATUSLINE_INSTANCE = "test-instance";
    expect(resolveV2SnapshotPaths()).toEqual({
      statePath: join(dirname(resolveStatePath()), "v2", "state.json"),
      textPath: "/tmp/opencode/fixture-runtime/opencode-subagent-statusline/test-instance/v2/status.txt",
    });
    process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE = "/tmp/opencode/exact/custom.json";
    expect(resolveV2SnapshotPaths()).toEqual({ statePath: "/tmp/opencode/exact/custom.json", textPath: "/tmp/opencode/exact/status.txt" });
  });

  it("coalesces the latest immutable snapshot with the existing schema and no V1 overwrite", async () => {
    const f = await fixture();
    const first = snapshot("First"); const last = snapshot("Last");
    f.writer.enqueue(first); f.writer.enqueue(last);
    last.children.ses_child.title = "Caller mutation";
    await f.writer.flush();
    const stored = JSON.parse(await readFile(f.statePath, "utf8"));
    expect(Object.keys(stored).sort()).toEqual(["children", "countedChildIDs", "totalExecuted", "updatedAt"]);
    expect(stored.children.ses_child.title).toBe("Last");
    expect(await readFile(f.textPath, "utf8")).toContain("Last");
    expect(last.children.ses_child.elapsedMs).toBeUndefined();
    await expect(readFile(join(f.dir, "state.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await f.writer.dispose(); await f.writer.dispose(); f.writer.enqueue(first); await f.writer.flush();
    expect(JSON.parse(await readFile(f.statePath, "utf8")).children.ses_child.title).toBe("Last");
  });

  it("serializes delayed state and text writes, keeping only the latest pending snapshot", async () => {
    const f = await fixture(); const barrier = await writeBarrier();
    f.writer.enqueue(snapshot("First")); await barrier.reached.promise;
    f.writer.enqueue(snapshot("Middle")); f.writer.enqueue(snapshot("Latest"));
    await expect(readFile(f.statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(f.statePath))).filter(name => name.endsWith(".tmp"))).toHaveLength(1);
    const flushing = f.writer.flush(); barrier.release.resolve(); await flushing;
    expect(JSON.parse(await readFile(f.statePath, "utf8")).children.ses_child.title).toBe("Latest");
    expect(await readFile(f.textPath, "utf8")).toContain("Latest");
    expect(vi.mocked(writeFile).mock.calls.map(([, data]) => String(data)).join("\n")).not.toContain("Middle");
    expect((await readdir(dirname(f.statePath))).sort()).toEqual(["state.json", "status.txt"]);
  });

  it("disposal invalidates queued writes and awaits cancellation of an already-started operation", async () => {
    const f = await fixture(); const barrier = await writeBarrier();
    f.writer.enqueue(snapshot("Old")); await barrier.reached.promise;
    f.writer.enqueue(snapshot("Queued"));
    let finished = false;
    const cleanup = f.writer.dispose().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    barrier.release.resolve(); await cleanup;
    expect(await readdir(dirname(f.statePath))).toEqual([]);
    // A replacement owner starts only after awaited cleanup, as Task 3 must enforce.
    const next = createV2SnapshotWriter({ statePath: f.statePath, textPath: f.textPath, onIssue: f.onIssue }); writers.push(next);
    next.enqueue(snapshot("New owner")); await next.flush();
    f.writer.enqueue(snapshot("Retired")); await f.writer.flush();
    expect(JSON.parse(await readFile(f.statePath, "utf8")).children.ses_child.title).toBe("New owner");
    expect(f.onIssue).not.toHaveBeenCalled();
  });

  it("reports sanitized I/O failure without mutating live memory and can write again", async () => {
    const f = await fixture(); const state = snapshot("Live"); const before = structuredClone(state);
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("PRIVATE disk failure"));
    f.writer.enqueue(state); await f.writer.flush();
    expect(f.onIssue.mock.calls).toEqual([["snapshot-failed"]]);
    expect(state).toEqual(before);
    expect(await readdir(dirname(f.statePath))).toEqual([]);
    f.writer.enqueue(state); await f.writer.flush();
    expect(JSON.parse(await readFile(f.statePath, "utf8")).children.ses_child.title).toBe("Live");
  });

  it("awaits a rename already handed to the filesystem before completing disposal", async () => {
    const f = await fixture(); const reached = deferred<void>(); const release = deferred<void>();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      reached.resolve(); await release.promise; await actual.rename(...args);
    });
    f.writer.enqueue(snapshot("Already committing")); await reached.promise;
    let finished = false; const cleanup = f.writer.dispose().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    release.resolve(); await cleanup;
    expect(JSON.parse(await readFile(f.statePath, "utf8")).children.ses_child.title).toBe("Already committing");
    expect(await readdir(dirname(f.statePath))).toEqual(["state.json"]);
  });

  it("cancels a same-turn enqueue before starting any filesystem work", async () => {
    const f = await fixture(); f.writer.enqueue(snapshot("Cancelled")); await f.writer.dispose();
    expect(await readdir(f.dir)).toEqual([]);
  });

  it("uses owner-only modes for newly created directories/files and leaves no temporary files", async () => {
    const f = await fixture(); f.writer.enqueue(snapshot("Private")); await f.writer.flush();
    expect((await stat(dirname(f.statePath))).mode & 0o777).toBe(0o700);
    expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(f.textPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(f.statePath))).sort()).toEqual(["state.json", "status.txt"]);
  });
});
