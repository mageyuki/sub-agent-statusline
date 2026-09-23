import type { SessionInfo, SessionListOutput, SessionActiveOutput, SessionMessageInfo } from "@opencode/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createV2Monitor, type V2Monitor, type V2MonitorInput } from "./tui-v2-state.js";
import { countRetainedSubagentStatuses } from "./state.js";
import { childInfo, deferred, deleted, failed, header, shutdown, started, succeeded, T0, usage } from "../test/helpers/v2-fixtures.js";

const monitors: V2Monitor[] = [];
function monitorFixture() {
  let infos = [childInfo()];
  let cached = true;
  const get = vi.fn<V2MonitorInput["session"]["get"]>(async ({ sessionID }) => {
    const info = infos.find(info => info.id === sessionID);
    if (!info) throw new Error("not found");
    return info;
  });
  const list = vi.fn<V2MonitorInput["session"]["list"]>(async input => ({
    data: infos.filter(info => info.parentID === input?.parentID), cursor: {},
  }));
  const active = vi.fn<V2MonitorInput["session"]["active"]>(async () => ({}));
  const messages = vi.fn<(id: string) => SessionMessageInfo[]>(() => []);
  const onChange = vi.fn();
  const onIssue = vi.fn();
  const invalidate = vi.fn();
  const monitor = createV2Monitor({ session: { get, list, active }, cache: {
    get: id => cached ? infos.find(info => info.id === id) : undefined,
    list: () => cached ? infos : [], sync: vi.fn(async () => {}), invalidate,
    message: { list: messages, get: () => undefined, sync: vi.fn(async () => {}), invalidate: vi.fn() },
  }, onChange, onIssue });
  monitors.push(monitor);
  return { monitor, get, list, active, messages, onChange, onIssue, invalidate,
    setInfo(info: SessionInfo) { infos = [info]; },
    setInfos(value: SessionInfo[]) { infos = value; },
    noCache() { cached = false; },
  };
}
function terminal(overrides: Partial<SessionInfo> = {}) {
  return childInfo({ outcome: "succeeded", time: { created: T0, updated: T0, idle: T0 + 2_000 }, ...overrides });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 20_000); });
afterEach(() => { monitors.splice(0).forEach(monitor => monitor.dispose()); });

describe("V2 execution evidence", () => {
  it("does not count metadata-only creation or double-count sequence zero", async () => {
    const f = monitorFixture();
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().totalExecuted).toBe(0);
    await f.monitor.accept(started(0, T0 + 1_000));
    await f.monitor.accept(started(0, T0 + 1_000));
    expect(f.monitor.state().totalExecuted).toBe(1);
    await f.monitor.accept(succeeded(2, T0 + 4_000));
    await f.monitor.accept(started(1, T0 + 2_000));
    expect(f.monitor.state().children.ses_child).toMatchObject({ status: "done",
      startedAt: new Date(T0).toISOString(), elapsedMs: 4_000, tokens: { input: 12, output: 3, total: 15 } });
    expect(f.monitor.state().children.ses_child.tokens?.contextPercent).toBeUndefined();
  });

  it("does not reinterpret old persisted success after shutdown; resumption clears timing", async () => {
    const f = monitorFixture(); f.setInfo(terminal());
    await f.monitor.refresh("ses_parent");
    await f.monitor.accept(started(4, T0 + 5_000));
    await f.monitor.accept(shutdown(6, T0 + 6_000));
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child.status).toBe("error");
    expect(f.monitor.hint("ses_child")).toBe("interrupted");
    expect(f.monitor.stale()).toBe(true);
    await f.monitor.accept(started(7, T0 + 7_000));
    expect(f.monitor.state().children.ses_child.status).toBe("running");
    expect(f.monitor.state().children.ses_child.endedAt).toBeUndefined();
    expect(f.monitor.hint("ses_child")).toBeUndefined();
    expect(f.monitor.state().totalExecuted).toBe(1);
  });

  it("uses active or newer idle outcome evidence to recover an interrupted child", async () => {
    const f = monitorFixture(); f.setInfo(terminal());
    await f.monitor.accept(started(1, T0 + 3_000));
    await f.monitor.accept(shutdown(2, T0 + 4_000));
    f.active.mockResolvedValue({ ses_child: { type: "running" } });
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child.status).toBe("running");
    expect(f.monitor.hint("ses_child")).toBeUndefined();
    expect(f.monitor.stale()).toBe(false);
    f.active.mockResolvedValue({});
    f.setInfo(terminal({ time: { created: T0, updated: T0, idle: T0 + 25_000 } }));
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child.status).toBe("done");
  });

  it("keeps equal-title real IDs distinct and projects only direct children", async () => {
    const f = monitorFixture();
    const infos = [terminal(), terminal({ id: "ses_second" }), terminal({ id: "ses_root", parentID: undefined }),
      terminal({ id: "ses_sibling", parentID: "ses_other" }), terminal({ id: "ses_grandchild", parentID: "ses_child" })];
    f.setInfos(infos);
    await f.monitor.refresh();
    expect(f.monitor.state().totalExecuted).toBe(4);
    expect(f.monitor.state().children.ses_root).toBeUndefined();
    expect(countRetainedSubagentStatuses({ children: f.monitor.state().children, parentSessionID: "ses_parent" }))
      .toEqual({ running: 0, done: 2, error: 0 });
    expect(f.list).not.toHaveBeenCalled();
  });

  it("ignores idle and tool success as outcomes and never stores failure bodies", async () => {
    const f = monitorFixture();
    await f.monitor.accept(started(0, T0));
    await f.monitor.accept({ id: "evt_idle", type: "session.idle", created: T0 + 1_000, data: { sessionID: "ses_child" } });
    await f.monitor.accept({ ...header(1, T0 + 2_000), type: "session.tool.success",
      durable: { aggregateID: "ses_child", seq: 1, version: 2 },
      data: { sessionID: "ses_child", assistantMessageID: "msg_test", id: "tool_test", executed: true,
        content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }] } });
    expect(f.monitor.state().children.ses_child.status).toBe("running");
    await f.monitor.accept(failed(2, T0 + 3_000));
    expect(f.monitor.state().children.ses_child.status).toBe("error");
    expect(f.monitor.hint("ses_child")).toBeUndefined();
    await f.monitor.accept(started(3, T0 + 4_000));
    await f.monitor.accept({ ...shutdown(4, T0 + 5_000), data: { sessionID: "ses_child", reason: "user" } });
    expect(f.monitor.hint("ses_child")).toBe("interrupted");
    await f.monitor.accept(started(5, T0 + 6_000));
    await f.monitor.accept(succeeded(6, T0 + 7_000));
    expect(f.monitor.state().children.ses_child.status).toBe("done");
    expect(JSON.stringify(f.monitor.state())).not.toContain("PRIVATE");
    expect(f.monitor.state().totalExecuted).toBe(1);
  });

  it("updates rename/agent/model after completion without reopening or recounting", async () => {
    const f = monitorFixture();
    await f.monitor.accept(succeeded(0, T0 + 1_000));
    await f.monitor.accept({ ...header(1, T0 + 2_000), type: "session.renamed", data: { sessionID: "ses_child", title: "Renamed" } });
    await f.monitor.accept({ ...header(2, T0 + 3_000), type: "session.agent.selected", data: { sessionID: "ses_child", agent: "reviewer" } });
    await f.monitor.accept({ ...header(3, T0 + 4_000), type: "session.model.selected", data: { sessionID: "ses_child", model: { providerID: "test", id: "model", variant: "small" } } });
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child).toMatchObject({ status: "done", title: "Renamed", agentName: "reviewer",
      model: { providerID: "test", modelID: "model", variant: "small" }, endedAt: new Date(T0 + 1_000).toISOString() });
    expect(f.monitor.state().totalExecuted).toBe(1);
  });

  it("reads optional assistant metadata by session ID, without retaining messages", async () => {
    const f = monitorFixture();
    f.messages.mockReturnValue([{ id: "msg_test", type: "assistant", time: { created: T0 }, agent: "helper",
      model: { providerID: "test", id: "unknown-model" }, content: [{ type: "text", text: "PRIVATE MESSAGE" }] }]);
    await f.monitor.accept(started(0, T0));
    expect(f.messages).toHaveBeenCalledWith("ses_child");
    expect(f.monitor.state().children.ses_child).toMatchObject({ agentName: "helper", model: { providerID: "test", modelID: "unknown-model" } });
    expect(f.monitor.state().children.ses_child.summary).toBeUndefined();
    expect(JSON.stringify(f.monitor.state())).not.toContain("PRIVATE");
  });

  it("applies known-child execution and metadata even when detail reads are unavailable", async () => {
    const f = monitorFixture();
    await f.monitor.accept(succeeded(0, T0 + 1_000));
    const previous = structuredClone(f.onChange.mock.lastCall?.[0]);
    const emitted = f.onChange.mock.lastCall?.[0];
    f.noCache(); f.get.mockRejectedValue(new Error("offline"));
    await f.monitor.accept(started(1, T0 + 2_000));
    await f.monitor.accept({ ...header(2, T0 + 3_000), type: "session.renamed", data: { sessionID: "ses_child", title: "New title" } });
    expect(f.monitor.state().children.ses_child).toMatchObject({ status: "running", title: "New title" });
    expect(emitted).toEqual(previous);
    expect(f.onIssue).not.toHaveBeenCalled();
  });

  it("replaces cumulative usage once and rejects older timestamps/invalid categories", async () => {
    const f = monitorFixture(); await f.monitor.accept(started(0, T0));
    await f.monitor.accept(usage(T0 + 3_000)); await f.monitor.accept(usage(T0 + 3_000));
    await f.monitor.accept(usage(T0 + 2_000, 500, 200));
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child.tokens).toEqual({ input: 40, output: 7, total: 47 });
    await f.monitor.accept(usage(T0 + 4_000, -1, Number.POSITIVE_INFINITY));
    expect(f.monitor.state().children.ses_child.tokens).toBeUndefined();
    await f.monitor.accept(usage(T0 + 5_000, 2, Number.NaN));
    expect(f.monitor.state().children.ses_child.tokens).toEqual({ input: 2, output: undefined, total: 2 });
  });
});

describe("V2 bounded reads and generations", () => {
  it.each(["failure", "repeated cursor"])("retains partial pages and active rows on %s", async mode => {
    const f = monitorFixture(); f.noCache();
    f.setInfos([childInfo({ id: "ses_active" })]);
    f.active.mockResolvedValue({ ses_active: { type: "running" } });
    f.list.mockResolvedValueOnce({ data: [terminal()], cursor: { next: "page2" } })
      .mockResolvedValueOnce({ data: [childInfo({ id: "ses_active" })], cursor: { next: "page3" } });
    if (mode === "failure") f.list.mockRejectedValueOnce(new Error("PRIVATE NETWORK"));
    else f.list.mockResolvedValueOnce({ data: [], cursor: { next: "page2" } });
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child.status).toBe("done");
    expect(f.monitor.state().children.ses_active.status).toBe("running");
    expect(f.monitor.stale()).toBe(true);
    expect(f.onIssue).toHaveBeenCalledWith("refresh-failed");
    expect(f.list.mock.calls.map(([input]) => input)).toEqual([
      { parentID: "ses_parent", limit: 100, cursor: undefined },
      { parentID: "ses_parent", limit: 100, cursor: "page2" },
      { parentID: "ses_parent", limit: 100, cursor: "page3" },
    ]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999); expect(f.list).toHaveBeenCalledTimes(3);
  });

  it("limits missing active detail reads to four concurrent calls", async () => {
    const f = monitorFixture(); f.noCache();
    const waiting = Array.from({ length: 9 }, () => deferred<SessionInfo>());
    f.active.mockResolvedValue(Object.fromEntries(waiting.map((_, i) => [`ses_${i}`, { type: "running" }])));
    let inFlight = 0; let max = 0;
    f.get.mockImplementation(async ({ sessionID }) => {
      inFlight++; max = Math.max(max, inFlight);
      const info = await waiting[Number(sessionID.slice(4))].promise; inFlight--; return info;
    });
    const refresh = f.monitor.refresh();
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(4));
    waiting.forEach((item, i) => item.resolve(childInfo({ id: `ses_${i}` })));
    await refresh;
    expect(max).toBe(4); expect(f.monitor.state().totalExecuted).toBe(9);
  });

  it("rejects an old get after a newer start", async () => {
    const f = monitorFixture(); f.noCache();
    const old = deferred<SessionInfo>();
    f.get.mockReturnValueOnce(old.promise);
    f.active.mockResolvedValue({ ses_child: { type: "running" } });
    const refresh = f.monitor.refresh();
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce());
    await f.monitor.accept(started(2, T0 + 5_000));
    old.resolve(terminal()); await refresh;
    expect(f.monitor.state().children.ses_child.status).toBe("running");
    expect(f.monitor.state().children.ses_child.endedAt).toBeUndefined();
  });

  it("does not resurrect a deleted row from pending get or cached metadata", async () => {
    const f = monitorFixture(); f.noCache();
    const old = deferred<SessionInfo>(); f.get.mockReturnValueOnce(old.promise);
    const start = f.monitor.accept(started(0, T0));
    await f.monitor.accept(deleted(1, T0 + 1_000));
    old.resolve(childInfo()); await start;
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children).toEqual({});
    expect(f.monitor.state().totalExecuted).toBe(0);
  });

  it("cannot close a newer start when an older terminal waits for identity", async () => {
    const f = monitorFixture(); f.noCache();
    const old = deferred<SessionInfo>(); f.get.mockReturnValueOnce(old.promise);
    const end = f.monitor.accept(succeeded(2, T0 + 2_000));
    await f.monitor.accept(started(3, T0 + 3_000));
    old.resolve(terminal()); await end;
    expect(f.monitor.state().children.ses_child).toMatchObject({ parentID: "ses_parent", status: "running" });
    expect(f.monitor.state().totalExecuted).toBe(1);
  });

  it.each(["list", "active"])("rejects an old %s result after newer execution/deletion", async kind => {
    const f = monitorFixture();
    const page = deferred<SessionListOutput>(); const activity = deferred<SessionActiveOutput>();
    if (kind === "list") f.list.mockReturnValueOnce(page.promise);
    else f.active.mockReturnValueOnce(activity.promise);
    const refresh = f.monitor.refresh("ses_parent");
    await vi.waitFor(() => expect(kind === "list" ? f.list : f.active).toHaveBeenCalledOnce());
    await f.monitor.accept(started(1, T0 + 3_000));
    await f.monitor.accept(succeeded(2, T0 + 4_000));
    page.resolve({ data: [childInfo()], cursor: {} }); activity.resolve({ ses_child: { type: "running" } });
    await refresh;
    expect(f.monitor.state().children.ses_child.status).toBe("done");
    await f.monitor.accept(deleted(3, T0 + 5_000));
    expect(f.monitor.state().totalExecuted).toBe(0);
  });

  it("reconnect invalidates old route reads and refreshes B without scanning home history", async () => {
    const f = monitorFixture(); f.noCache();
    const old = deferred<SessionListOutput>(); f.list.mockReturnValueOnce(old.promise);
    const routeA = f.monitor.refresh("ses_A");
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    f.setInfos([terminal({ id: "ses_Bchild", parentID: "ses_B" })]);
    await f.monitor.refresh("ses_B");
    await Promise.all([f.monitor.reconnect(), f.monitor.reconnect()]);
    old.resolve({ data: [terminal({ parentID: "ses_A" })], cursor: {} }); await routeA;
    expect(f.monitor.state().children.ses_child).toBeUndefined();
    expect(f.monitor.state().children.ses_Bchild.status).toBe("done");
    expect(f.list.mock.calls.map(([input]) => input?.parentID)).toEqual(["ses_A", "ses_B", "ses_B"]);
    const calls = f.list.mock.calls.length; await f.monitor.refresh();
    expect(f.list).toHaveBeenCalledTimes(calls);
    expect(f.monitor.state().totalExecuted).toBe(1);
  });

  it("coalesces refreshes and bounds backoff to six nonzero retries", async () => {
    const f = monitorFixture(); f.list.mockRejectedValue(new Error("PRIVATE"));
    await Promise.all([f.monitor.refresh("ses_parent"), f.monitor.refresh("ses_parent")]);
    expect(f.list).toHaveBeenCalledOnce();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      const calls = f.list.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(f.list).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1); expect(f.list).toHaveBeenCalledTimes(calls + 1);
    }
    await vi.runAllTimersAsync(); expect(f.list).toHaveBeenCalledTimes(7);
    expect(f.monitor.stale()).toBe(true);
    expect(f.onChange).toHaveBeenCalled();
    await f.monitor.refresh("ses_other");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retries missing event identity even on home with empty active/cache data", async () => {
    const f = monitorFixture(); f.noCache();
    f.get.mockRejectedValueOnce(new Error("offline"));
    await f.monitor.accept(started(0, T0 + 1_000));
    expect(f.monitor.stale()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.monitor.state().children.ses_child.status).toBe("running");
    expect(f.monitor.stale()).toBe(false);
  });

  it("an older successful inventory cannot clear a newer failed identity read or its retry", async () => {
    const f = monitorFixture(); f.noCache();
    const old = deferred<SessionListOutput>(); f.list.mockReturnValueOnce(old.promise);
    const refresh = f.monitor.refresh("ses_parent");
    f.get.mockRejectedValueOnce(new Error("offline"));
    await f.monitor.accept(started(0, T0 + 1_000));
    old.resolve({ data: [], cursor: {} }); await refresh;
    expect(f.monitor.stale()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.monitor.state().children.ses_child.status).toBe("running");
    expect(f.monitor.stale()).toBe(false);
  });

  it("rejects unchanged old success after a start even when time.updated is newer", async () => {
    const f = monitorFixture();
    await f.monitor.accept(started(0, T0 + 3_000));
    f.setInfo(terminal({ time: { created: T0, updated: T0 + 10_000, idle: T0 + 2_000 } }));
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child.status).toBe("running");
  });

  it("does not reopen a hydrated terminal outcome with a delayed older start", async () => {
    const f = monitorFixture(); f.setInfo(terminal());
    await f.monitor.refresh("ses_parent");
    await f.monitor.accept(started(0, T0 + 1_000));
    expect(f.monitor.state().children.ses_child.status).toBe("done");
  });

  it("cancels superseded route retry and coalesces activity hints", async () => {
    const f = monitorFixture(); f.list.mockRejectedValueOnce(new Error("offline"));
    await f.monitor.refresh("ses_parent");
    await f.monitor.refresh("ses_other");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.list).toHaveBeenCalledTimes(2);
    await Promise.all(Array.from({ length: 20 }, (_, i) => f.monitor.accept({
      type: "session.status", id: `hint_${i}`, created: T0 + i,
      data: { sessionID: "ses_child", status: { type: "running" } },
    })));
    await vi.advanceTimersByTimeAsync(999); expect(f.list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(f.list).toHaveBeenCalledTimes(3);
    expect(f.monitor.state().totalExecuted).toBe(0);
  });

  it("treats retry scheduling as a coalesced refresh hint, not a failed execution", async () => {
    const f = monitorFixture(); await f.monitor.accept(started(0, T0));
    await f.monitor.accept({ ...header(1, T0 + 1_000), type: "session.retry.scheduled", data: {
      sessionID: "ses_child", assistantMessageID: "msg_retry", attempt: 2, at: T0 + 2_000,
      error: { type: "unknown", message: "PRIVATE RETRY" },
    } });
    expect(vi.getTimerCount()).toBe(1);
    expect(f.monitor.state().children.ses_child.status).toBe("running");
    expect(JSON.stringify(f.monitor.state())).not.toContain("PRIVATE");
  });

  it("prunes only terminal history at 1500 rows and three days", async () => {
    const f = monitorFixture(); f.noCache();
    const rows = Array.from({ length: 1501 }, (_, i) => terminal({ id: `ses_${i}` }));
    rows.push(terminal({ id: "ses_expired", time: { created: T0 - 4 * 86400_000, updated: T0, idle: T0 - 4 * 86400_000 } }));
    f.list.mockImplementation(async input => {
      const offset = Number(input?.cursor ?? 0); const next = offset + 100;
      return { data: rows.slice(offset, next), cursor: next < rows.length ? { next: String(next) } : {} };
    });
    f.active.mockResolvedValue({ ses_active: { type: "running" } });
    f.get.mockResolvedValue(childInfo({ id: "ses_active", time: { created: T0 - 5 * 86400_000, updated: T0 } }));
    await f.monitor.refresh("ses_parent");
    expect(Object.values(f.monitor.state().children).filter(child => child.status === "done")).toHaveLength(1500);
    expect(f.monitor.state().children.ses_expired).toBeUndefined();
    expect(f.monitor.state().children.ses_active.status).toBe("running");
    expect(f.monitor.state().totalExecuted).toBe(1501);
    await f.monitor.refresh();
    expect(f.get).toHaveBeenCalledTimes(2); // only the active ID, not pruned history
  });

  it("expires interruption feedback with its terminal row, not as a permanent stale flag", async () => {
    const f = monitorFixture();
    await f.monitor.accept(started(0, T0)); await f.monitor.accept(shutdown(1, T0 + 1_000));
    vi.setSystemTime(T0 + 4 * 86400_000);
    await f.monitor.refresh("ses_parent");
    expect(f.monitor.state().children.ses_child).toBeUndefined();
    expect(f.monitor.hint("ses_child")).toBeUndefined();
    expect(f.monitor.stale()).toBe(false);
  });

  it("disposes pending details and retries without later change or calls", async () => {
    const f = monitorFixture(); f.noCache();
    f.list.mockRejectedValue(new Error("offline")); await f.monitor.refresh("ses_parent");
    const pending = deferred<SessionInfo>(); f.get.mockReturnValueOnce(pending.promise);
    const event = f.monitor.accept(started(0, T0));
    f.monitor.dispose(); f.monitor.dispose(); f.onChange.mockClear(); f.onIssue.mockClear();
    const calls = f.get.mock.calls.length + f.list.mock.calls.length;
    pending.resolve(childInfo()); await event; await vi.runAllTimersAsync();
    await f.monitor.refresh("ses_parent"); await f.monitor.reconnect();
    expect(f.onChange).not.toHaveBeenCalled(); expect(f.onIssue).not.toHaveBeenCalled();
    expect(f.get.mock.calls.length + f.list.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});
