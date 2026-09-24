import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyEvent, TextareaRenderable, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import v2Plugin from "../src/tui-v2.js";
import { createV2ContextHarness, hasNativeFFI, invokeV2KeyboardCommand } from "./helpers/v2-context.js";
import { childInfo, deferred, deleted, header, shutdown, started, T0 } from "./helpers/v2-fixtures.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
type Host = Awaited<ReturnType<typeof createV2ContextHarness>>;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  // Keep retention fixtures deterministic without faking native renderer timers.
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0 + 86_400_000);
  const dir = await mkdtemp(join(tmpdir(), "subagent-v2-setup-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE = statePath;
  const host = await createV2ContextHarness();
  cleanups.push(() => host.renderer.destroy());
  return { host, dir, statePath };
}
async function start(host: Host) {
  const cleanup = await v2Plugin.setup(host.context);
  if (!cleanup) throw new Error("Setup must own its cleanup");
  cleanups.push(cleanup);
  host.mount(); await host.flush();
  return cleanup;
}
function command(host: Host, suffix: string) {
  const found = host.layers().flatMap(layer => layer.commands ?? [])
    .filter(item => item.id === `subagent-statusline.${suffix}`);
  expect(found).toHaveLength(1);
  return found[0];
}
function list(host: Host) { return host.layers().find(layer => layer.target)?.target?.() as BoxRenderable | undefined; }
function keyEvent(name: string, modifiers: Partial<Pick<KeyEvent, "ctrl" | "shift" | "meta" | "option">> = {}) {
  return new KeyEvent({ name, raw: name, sequence: name, ctrl: false, shift: false,
    meta: false, option: false, number: false, eventType: "press", source: "raw", ...modifiers });
}
function key(host: Host, name: string, modifiers: Partial<Pick<KeyEvent, "ctrl" | "shift" | "meta" | "option">> = {}, binding = name) {
  const event = keyEvent(name, modifiers);
  const layer = host.layers().find(item => item.target);
  const registered = layer?.commands?.find(item => item.bind === binding);
  if (!registered) throw new Error(`Missing list binding: ${binding}`);
  invokeV2KeyboardCommand(registered, event);
  return event;
}
function altB(host: Host, event = keyEvent("b", { meta: true })) {
  const registered = host.layers().find(layer => layer.mode === "base" && !layer.target)?.commands?.find(item => item.bind === "alt+b");
  if (!registered) throw new Error("Missing base Alt+B binding");
  return invokeV2KeyboardCommand(registered, event);
}

describe.skipIf(!hasNativeFFI)("V2 mounted setup integration (requires node:ffi)", () => {
  it("receives host keyboard events through named nonpalette bindings and consumes list Esc exactly once", async () => {
    const { host } = await fixture(); await start(host);
    const entry = keyEvent("b", { meta: true });
    const entryPrevent = vi.spyOn(entry, "preventDefault"), entryStop = vi.spyOn(entry, "stopPropagation");
    expect(altB(host, entry)).not.toBe(false);
    expect(list(host)?.focused).toBe(true);
    expect(entryPrevent).toHaveBeenCalledOnce(); expect(entryStop).toHaveBeenCalledOnce();

    const esc = keyEvent("escape");
    const prevent = vi.spyOn(esc, "preventDefault"), stop = vi.spyOn(esc, "stopPropagation");
    const exit = host.layers().find(layer => layer.target)?.commands?.find(item => item.bind === "escape");
    expect(exit).toBeDefined();
    expect(invokeV2KeyboardCommand(exit!, esc)).not.toBe(false);
    expect(prevent).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
    expect(esc.defaultPrevented).toBe(true); expect(esc.propagationStopped).toBe(true);
    expect(host.renderer.currentFocusedEditor).toBe(host.prompt);

    const palette = host.layers().flatMap(layer => layer.commands ?? []).filter(item => item.palette);
    expect(palette.map(item => item.id).sort()).toEqual([
      "subagent-statusline.focus-sidebar-list", "subagent-statusline.toggle-completed-history",
      "subagent-statusline.toggle-sidebar-section",
    ]);
    expect(palette.every(item => item.bind === false)).toBe(true);
    const keyboard = host.layers().filter(layer => layer.mode === "base").flatMap(layer => layer.commands ?? []);
    expect(keyboard.every(item => item.id?.startsWith("subagent-statusline.internal.") && !item.palette && !item.slash)).toBe(true);
    expect(new Set(keyboard.map(item => item.id)).size).toBe(keyboard.length);
  });

  it("owns additive slots, typed subscriptions and component-only layers across remount and cleanup", async () => {
    const { host } = await fixture(); const cleanup = await start(host);
    expect(v2Plugin.id).toBe("subagent-statusline.tui");
    expect(host.slotPaths()).toEqual(["app", "sidebar.content", "home.footer.status"]);
    expect(host.captureCharFrame()).toContain("Owned child");
    expect(host.captureCharFrame()).toContain("Input + output usage");
    expect(host.captureCharFrame()).not.toContain("ctx");
    expect(host.messageList).toHaveBeenCalledWith("ses_child");
    const focus = command(host, "focus-sidebar-list");
    expect(focus).toMatchObject({ palette: true, bind: false, title: "Subagents: Focus sidebar list" });
    expect(host.layers().find(layer => layer.commands?.some(item => item.id === focus.id))?.mode).toBe("global");
    expect(host.layers().filter(layer => layer.mode === "base")).toHaveLength(2);
    expect(host.layers().find(layer => layer.target)?.commands?.map(item => item.bind)).toEqual([
      "j", "k", "up", "down", "return", "c", "h", "l", "left", "right", "escape", "alt+b",
    ]);
    expect(host.stored).toEqual([{ key: "subagents.sidebar", value: { enabled: true, expanded: true } }]);
    host.unmount(); expect(host.layers()).toHaveLength(0);
    host.mount(); expect(command(host, "focus-sidebar-list")).toBeDefined();
    await cleanup(); await cleanup();
    expect(host.activeHandlers()).toBe(0); expect(host.activeClaims()).toBe(0); expect(host.layers()).toHaveLength(0);
  });

  it("lets base Alt+B fall through when a live list has no safe return editor, but consumes transfer and release", async () => {
    const { host } = await fixture(); await start(host);
    expect(list(host)?.isDestroyed).toBe(false);
    host.prompt.blur();
    expect(host.renderer.currentFocusedRenderable).toBeNull();
    expect(host.renderer.currentFocusedEditor).toBeNull();
    const refused = keyEvent("b", { meta: true });
    expect(altB(host, refused)).toBe(false);
    expect(refused.defaultPrevented).toBe(false); expect(refused.propagationStopped).toBe(false);
    expect(list(host)?.focused).toBe(false);

    host.prompt.focus();
    const accepted = keyEvent("b", { meta: true });
    expect(altB(host, accepted)).not.toBe(false);
    expect(accepted.defaultPrevented).toBe(true); expect(accepted.propagationStopped).toBe(true);
    expect(list(host)?.focused).toBe(true);
    const released = keyEvent("b", { meta: true });
    expect(altB(host, released)).not.toBe(false);
    expect(released.defaultPrevented).toBe(true); expect(released.propagationStopped).toBe(true);
    expect(host.renderer.currentFocusedEditor).toBe(host.prompt);
  });

  it.each(["immediate", "deferred"])("contains %s unavailable feedback failure without duplicates or late disposed feedback", async delivery => {
    const { host } = await fixture(); const cleanup = await start(host);
    vi.useFakeTimers();
    const request = command(host, "focus-sidebar-list");
    host.toast.mockImplementation(() => { throw new Error("PRIVATE toast body"); });
    if (delivery === "immediate") {
      host.setSidebar(false);
      expect(() => request.run()).not.toThrow();
    } else {
      host.setMode("modal"); request.run();
      await vi.advanceTimersByTimeAsync(299);
      expect(host.toast).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(host.toast).toHaveBeenCalledOnce();
    expect(host.toast).toHaveBeenLastCalledWith({ message: "Subagent list unavailable", variant: "info" });
    await vi.advanceTimersByTimeAsync(600);
    expect(host.toast).toHaveBeenCalledOnce();

    // A fresh user request still gets one feedback attempt, not lifetime suppression.
    host.setSidebar(false);
    expect(() => request.run()).not.toThrow();
    expect(host.toast).toHaveBeenCalledTimes(2);
    host.setSidebar(true); host.setMode("modal"); request.run();
    await cleanup();
    request.run();
    await vi.advanceTimersByTimeAsync(300);
    expect(host.toast).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(host.toast.mock.calls)).not.toContain("PRIVATE");
    vi.useRealTimers();
  });

  it("defers palette focus, preserves dialog input, returns once on Esc and releases before child navigation", async () => {
    const { host } = await fixture(); await start(host);
    const dialog = new TextareaRenderable(host.renderer, { width: 40, height: 2 });
    host.renderer.root.add(dialog); dialog.focus();
    host.setMode("modal"); altB(host);
    expect(host.renderer.currentFocusedEditor).toBe(dialog);
    vi.useFakeTimers(); command(host, "focus-sidebar-list").run();
    await vi.advanceTimersByTimeAsync(60);
    expect(host.renderer.currentFocusedEditor).toBe(dialog);
    host.setMode("base"); dialog.destroy(); host.prompt.focus();
    await vi.advanceTimersByTimeAsync(30);
    expect(list(host)?.focused).toBe(true);
    expect(list(host)?.backgroundColor).toEqual(host.context.theme.background.raised.base);
    const focusSpy = vi.spyOn(host.prompt, "focus");
    const esc = key(host, "escape");
    expect(esc.defaultPrevented).toBe(true); expect(esc.propagationStopped).toBe(true);
    expect(focusSpy).toHaveBeenCalledOnce();
    altB(host); altB(host); expect(focusSpy).toHaveBeenCalledTimes(2);
    altB(host); key(host, "return");
    await Promise.resolve(); await Promise.resolve();
    expect(host.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "ses_child" });
    expect(list(host)?.focused).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("keeps modified keys inert, local preferences bounded and a hidden/disabled/empty list unfocused", async () => {
    const { host } = await fixture(); await start(host);
    const target = list(host)!; altB(host);
    for (const name of ["j", "k", "up", "down", "left", "right", "return", "escape"]) {
      expect(key(host, name, { meta: true }).defaultPrevented).toBe(false);
    }
    expect(host.navigate).not.toHaveBeenCalled(); expect(target.focused).toBe(true);
    key(host, "h"); expect(host.mutations.at(-1)).toEqual({ enabled: true, expanded: false });
    key(host, "l"); key(host, "c");
    expect(host.mutations.at(-1)).toEqual({ enabled: true, expanded: true });
    await command(host, "toggle-sidebar-section").run();
    expect(host.renderer.currentFocusedEditor).toBe(host.prompt);
    expect(list(host)).toBeUndefined();
    command(host, "focus-sidebar-list").run();
    expect(host.toast).toHaveBeenLastCalledWith(expect.objectContaining({ message: "Subagent list unavailable" }));
    await command(host, "toggle-sidebar-section").run();
    host.setSidebar(false); expect(altB(host)).toBe(false); expect(host.renderer.currentFocusedEditor).toBe(host.prompt);
    host.setSidebar(true); host.emit(deleted(99, Date.now())); await Promise.resolve();
    expect(altB(host)).toBe(false); expect(host.renderer.currentFocusedEditor).toBe(host.prompt);
    expect(Object.keys(host.stored[0].value)).toEqual(["enabled", "expanded"]);
  });

  it("uses the child's model location, displays truthful interruption and renders compact observed home totals", async () => {
    const { host } = await fixture();
    host.setInfos([childInfo({ location: { directory: "/fixture/other" }, model: { providerID: "test", id: "model", variant: "high" } })]);
    host.modelList.mockReturnValue([{ id: "model", modelID: "model", providerID: "test", name: "Named model",
      capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: T0 },
      cost: [], status: "active", enabled: true, limit: { context: 100_000, output: 10_000 } }]);
    await start(host);
    expect(host.modelList).toHaveBeenCalledWith({ directory: "/fixture/other" });
    expect(host.captureCharFrame()).toContain("Named model · high");
    host.emit(shutdown(20, Date.now())); await host.flush();
    expect(host.captureCharFrame()).toContain("Interrupted");
    expect(host.captureCharFrame()).toContain("Status may be stale");
    host.setRoute({ type: "home" }); await host.flush();
    expect(host.captureCharFrame()).toContain("Σ 1");
    expect(host.captureCharFrame()).not.toContain("Input + output usage");
  });

  it("unwinds partial setup and preserves its original exception", async () => {
    const { host } = await fixture(); host.failures.slot = 2;
    await expect(v2Plugin.setup(host.context)).rejects.toThrow("Original slot failure");
    expect(host.activeHandlers()).toBe(0); expect(host.activeClaims()).toBe(0); expect(host.layers()).toHaveLength(0);
    expect(host.reads.list).not.toHaveBeenCalled();
  });

  it("runs independent teardown after disposal failures without leaking raw exceptions", async () => {
    const { host } = await fixture(); const cleanup = await start(host);
    host.failures.unsubscribe = true; host.failures.disposeSlot = true;
    await cleanup(); await cleanup();
    expect(host.activeHandlers()).toBe(0); expect(host.activeClaims()).toBe(0); expect(host.layers()).toHaveLength(0);
    expect(JSON.stringify(host.toast.mock.calls)).not.toContain("PRIVATE");
  });

  it("invalidates pending hydration/focus immediately and awaits old real snapshot I/O before reload", async () => {
    const { host, dir, statePath } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const reached = deferred<void>(), release = deferred<void>();
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await actual.writeFile(...args); reached.resolve(); await release.promise;
    });
    const pending = deferred<Awaited<ReturnType<Host["reads"]["list"]>>>();
    host.reads.list.mockReturnValueOnce(pending.promise);
    const cleanup = await start(host); await reached.promise;
    command(host, "focus-sidebar-list").run();
    let finished = false; const closing = Promise.resolve(cleanup()).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false); expect(host.activeHandlers()).toBe(0); expect(host.layers()).toHaveLength(0);
    const writes = vi.mocked(writeFile).mock.calls.length;
    pending.resolve({ data: [childInfo({ title: "Retired generation" })], cursor: {} });
    host.emit(started(30, Date.now()));
    release.resolve(); await closing;
    expect(await readdir(dir)).toEqual([]);
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(writes);
    expect(host.renderer.currentFocusedEditor).toBe(host.prompt);
    await start(host);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(statePath, "utf8")).children.ses_child.title).toBe("Owned child"));
    expect(host.captureCharFrame()).not.toContain("Retired generation");
    expect(command(host, "focus-sidebar-list")).toBeDefined();
  });

  it("contains snapshot and preference errors while keeping live monitor rows", async () => {
    const { host } = await fixture();
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("PRIVATE disk body"));
    await start(host);
    await vi.waitFor(() => expect(host.toast).toHaveBeenCalled());
    expect(host.captureCharFrame()).toContain("Owned child");
    host.updateFailure.error = new Error("PRIVATE preference body");
    await command(host, "toggle-sidebar-section").run();
    expect(host.captureCharFrame()).toContain("Owned child");
    expect(JSON.stringify(host.toast.mock.calls)).not.toContain("PRIVATE");
  });

  it("restores only row/history presentation after parent return to a new native editor", async () => {
    const { host } = await fixture();
    const old = childInfo({ id: "ses_old", title: "Retained history", outcome: "succeeded",
      time: { created: T0 - 600_000, updated: T0, idle: T0 } });
    host.setInfos([childInfo(), old]);
    await start(host); expect(host.captureCharFrame()).not.toContain("Retained history");
    altB(host); key(host, "c"); key(host, "j"); key(host, "return");
    await Promise.resolve(); await Promise.resolve();
    expect(host.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "ses_old" });
    const prior = host.prompt;
    host.setRoute({ type: "session", sessionID: "ses_old" }); host.replacePrompt(); await host.flush();
    expect(prior.isDestroyed).toBe(true);
    host.setRoute({ type: "session", sessionID: "ses_parent" }); host.replacePrompt(); await host.flush();
    expect(host.captureCharFrame()).toContain("Retained history");
    expect(list(host)?.focused).toBe(false);
    await host.mockInput.typeText("returned typing");
    expect(host.prompt.plainText).toBe("returned typing");
    host.navigate.mockClear(); altB(host); key(host, "return");
    await Promise.resolve(); await Promise.resolve();
    expect(host.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "ses_old" });
  });

  it.each(["deleted", "route", "unmount", "rejected"])("cancels navigation when its pending target becomes %s", async cause => {
    const { host } = await fixture(); await start(host);
    const detail = deferred<ReturnType<typeof childInfo>>();
    host.reads.get.mockReturnValueOnce(detail.promise);
    altB(host); key(host, "return");
    expect(host.reads.get).toHaveBeenCalledWith({ sessionID: "ses_child" });
    if (cause === "deleted") host.emit(deleted(50, Date.now()));
    if (cause === "route") host.setRoute({ type: "session", sessionID: "ses_other" });
    if (cause === "unmount") host.setSidebar(false);
    if (cause === "rejected") detail.reject(new Error("Missing target"));
    else detail.resolve(childInfo());
    await Promise.resolve(); await Promise.resolve();
    expect(host.navigate).not.toHaveBeenCalled();
  });

  it("preserves real mouse selection/history and treats deletion between mouse down/up as a no-op", async () => {
    const { host } = await fixture();
    host.setInfos([childInfo(), childInfo({ id: "ses_old", title: "Retained mouse target", outcome: "succeeded",
      time: { created: T0 - 600_000, updated: T0, idle: T0 } })]);
    await start(host);
    const target = list(host)!;
    const scroll = target.getChildren().find(node => node.constructor.name === "ScrollBoxRenderable") as ScrollBoxRenderable;
    const row = scroll.content.getChildren()[0].getChildren()[0] as BoxRenderable;
    const x = row.x + 6, y = row.y;
    await host.mockMouse.pressDown(x, y);
    host.emit(deleted(50, Date.now())); await host.flush();
    await host.mockMouse.release(x, y);
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.captureCharFrame()).not.toContain("Retained mouse target");
    const sigma = target.getChildren()[1].getChildren().at(-1) as BoxRenderable;
    await host.mockMouse.click(sigma.x, sigma.y); await host.flush();
    expect(host.captureCharFrame()).toContain("Retained mouse target");
    const retained = scroll.content.getChildren()[0].getChildren()[0] as BoxRenderable;
    await host.mockMouse.click(retained.x + 6, retained.y);
    await Promise.resolve();
    expect(host.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "ses_old" });
    expect(host.mutations).toEqual([]);
  });

  it("keeps selection by child identity when newly started work prepends a row", async () => {
    const { host } = await fixture(); await start(host);
    altB(host);
    host.setInfos([childInfo(), childInfo({ id: "ses_new", title: "Newer work",
      time: { created: Date.now(), updated: Date.now() } })]);
    host.emit(started(1, Date.now(), "ses_new")); await host.flush();
    expect(host.captureCharFrame()).toContain("Newer work");
    key(host, "return"); await Promise.resolve(); await Promise.resolve();
    expect(host.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "ses_child" });
  });

  it("cancels a mounted palette request on sidebar unmount even if it remounts on the same route", async () => {
    const { host } = await fixture(); await start(host);
    vi.useFakeTimers();
    command(host, "focus-sidebar-list").run();
    host.setSidebar(false); host.setSidebar(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(host.renderer.currentFocusedEditor).toBe(host.prompt);
    expect(list(host)?.focused).toBe(false);
    vi.useRealTimers();
  });

  it("updates owned width, keeps the visible row anchor and removes layout listeners on unmount", async () => {
    const { host } = await fixture();
    const rows = Array.from({ length: 14 }, (_, index) => childInfo({ id: `ses_${index}`, title: `Work ${index}` }));
    host.setInfos(rows);
    host.reads.active.mockResolvedValue(Object.fromEntries(rows.map(row => [row.id, { type: "running" as const }])));
    await start(host);
    const target = list(host)!;
    const wrapper = target.parent as BoxRenderable;
    const scroll = target.getChildren().find(node => node.constructor.name === "ScrollBoxRenderable") as ScrollBoxRenderable;
    expect(wrapper.listenerCount("layout-changed")).toBeGreaterThan(0);
    scroll.scrollTop = 5;
    host.emit({ ...header(10, Date.now(), "ses_0"), type: "session.agent.selected",
      data: { sessionID: "ses_0", agent: "reviewer" } });
    await host.flush(); expect(scroll.scrollTop).toBe(6);
    const wide = wrapper.width;
    host.resize(34, 45); await host.flush(); expect(wrapper.width).toBeLessThan(wide);
    altB(host); for (let i = 0; i < 13; i++) key(host, "j");
    await host.flush(); expect(scroll.scrollTop).toBeGreaterThan(6);
    host.setSidebar(false);
    expect(wrapper.listenerCount("layout-changed")).toBe(0);
    expect(wrapper.listenerCount("resized")).toBe(0);
    expect(host.renderer.currentFocusedEditor).toBe(host.prompt);
  });

  it("refreshes the current route on typed reconnect and ticks only while running", async () => {
    const { host } = await fixture(); await start(host);
    host.setRoute({ type: "session", sessionID: "ses_other" }); await host.flush();
    host.reads.list.mockClear();
    host.emit({ id: "evt_connection", type: "server.connected", data: {} });
    await host.flush();
    expect(host.reads.list).toHaveBeenCalledWith({ parentID: "ses_other", limit: 100, cursor: undefined });
    host.setRoute({ type: "session", sessionID: "ses_parent" }); await host.flush();
    const intervals = vi.spyOn(globalThis, "setInterval"), cleared = vi.spyOn(globalThis, "clearInterval");
    host.emit(shutdown(20, Date.now())); await Promise.resolve();
    expect(cleared).toHaveBeenCalled();
    host.emit(started(21, Date.now() + 1)); await Promise.resolve();
    expect(intervals).toHaveBeenCalledOnce();
    expect(intervals).toHaveBeenCalledWith(expect.any(Function), 1_000);
    host.emit(started(22, Date.now() + 2)); await Promise.resolve();
    expect(intervals).toHaveBeenCalledOnce();
  });
});
