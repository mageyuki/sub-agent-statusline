import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ELAPSED_TICK_MS, MAINTENANCE_TICK_MS, TERMINAL_CHILD_TTL_MS } from "./internal-policy.js";

import type { ChildSessionState, StatuslineState } from "./state.js";
import {
  createTuiMaintenanceTimers,
  runTuiStateMaintenance,
} from "./tui-v1.js";

function child(overrides: Partial<ChildSessionState> = {}): ChildSessionState {
  return {
    id: "ses_child",
    title: "Child",
    parentID: "ses_parent",
    source: "session",
    targetSessionID: "ses_child",
    status: "done",
    color: "green",
    startedAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T09:01:00.000Z",
    endedAt: "2026-07-17T09:01:00.000Z",
    elapsedMs: 60_000,
    ...overrides,
  };
}

function state(children: ChildSessionState[]): StatuslineState {
  return {
    children: Object.fromEntries(children.map((item) => [item.id, item])),
    countedChildIDs: Object.fromEntries(children.map((item) => [item.id, true])),
    totalExecuted: children.length,
    updatedAt: "2026-07-17T09:01:00.000Z",
  };
}

function apiWithReadSpies() {
  const status = vi.fn(() => ({ type: "idle" }));
  const messages = vi.fn(() => [{ id: "msg_child" }]);
  const part = vi.fn(() => []);
  const api = {
    state: { session: { status, messages }, part },
  } as unknown as TuiPluginApi;
  return { api, status, messages, part };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TUI maintenance timers", () => {
  it("does no fast work for terminal-only state", () => {
    vi.useFakeTimers();
    const elapsed = vi.fn();
    const maintenance = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: elapsed,
      onMaintenanceTick: maintenance,
    });

    timers.syncElapsedTimer(false);
    vi.advanceTimersByTime(MAINTENANCE_TICK_MS - 1);
    expect(elapsed).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(maintenance).toHaveBeenCalledOnce();
    expect(elapsed).not.toHaveBeenCalled();
    timers.dispose();
  });

  it("starts and stops elapsed ticking with running state", () => {
    vi.useFakeTimers();
    const elapsed = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: elapsed,
      onMaintenanceTick: vi.fn(),
    });

    timers.syncElapsedTimer(true);
    vi.advanceTimersByTime(ELAPSED_TICK_MS - 1);
    expect(elapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(elapsed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(ELAPSED_TICK_MS);
    expect(elapsed).toHaveBeenCalledTimes(2);

    timers.syncElapsedTimer(false);
    vi.advanceTimersByTime(2 * ELAPSED_TICK_MS);
    expect(elapsed).toHaveBeenCalledTimes(2);
    timers.dispose();
  });

  it("keeps persistence outside elapsed-only ticks", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const elapsed = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: elapsed,
      onMaintenanceTick: persist,
    });

    timers.syncElapsedTimer(true);
    vi.advanceTimersByTime(MAINTENANCE_TICK_MS - 1);
    expect(persist).not.toHaveBeenCalled();
    expect(elapsed).toHaveBeenCalledTimes(Math.floor((MAINTENANCE_TICK_MS - 1) / ELAPSED_TICK_MS));
    vi.advanceTimersByTime(1);
    expect(persist).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(MAINTENANCE_TICK_MS);
    expect(persist).toHaveBeenCalledTimes(2);
    timers.dispose();
  });

  it("runs reconciliation maintenance while elapsed ticking is idle", () => {
    vi.useFakeTimers();
    const reconcile = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: vi.fn(),
      onMaintenanceTick: reconcile,
    });

    timers.syncElapsedTimer(false);
    vi.advanceTimersByTime(MAINTENANCE_TICK_MS - 1);
    expect(reconcile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconcile).toHaveBeenCalledOnce();
    timers.dispose();
  });

  it("cleans up elapsed and maintenance timers", () => {
    vi.useFakeTimers();
    const elapsed = vi.fn();
    const maintenance = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: elapsed,
      onMaintenanceTick: maintenance,
    });
    timers.syncElapsedTimer(true);

    timers.dispose();
    vi.advanceTimersByTime(2 * Math.max(ELAPSED_TICK_MS, MAINTENANCE_TICK_MS));

    expect(elapsed).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TUI state maintenance", () => {
  it("performs zero history reads for terminal children with complete tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api, status, messages, part } = apiWithReadSpies();
    const current = state([child({ tokens: { total: 42 } })]);

    expect(runTuiStateMaintenance(api, current)).toBe(current);
    expect(status).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(part).not.toHaveBeenCalled();
  });

  it("preserves terminal token fallback reads while idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api, status, messages, part } = apiWithReadSpies();
    const current = state([child({ id: "ses_fallback" })]);

    runTuiStateMaintenance(api, current);

    expect(status).toHaveBeenCalledWith("ses_fallback");
    expect(messages).toHaveBeenCalledWith("ses_fallback");
    expect(part).toHaveBeenCalledWith("msg_child");
  });

  it("prunes expired terminal children while idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api } = apiWithReadSpies();
    const expiredAt = new Date(Date.now() - TERMINAL_CHILD_TTL_MS - 1).toISOString();
    const current = state([
      child({
        id: "expired",
        tokens: { total: 1 },
        updatedAt: expiredAt,
        endedAt: expiredAt,
      }),
    ]);

    const next = runTuiStateMaintenance(api, current);

    expect(next).not.toBe(current);
    expect(next.children).toEqual({});
  });
});
