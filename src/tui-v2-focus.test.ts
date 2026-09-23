import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoxRenderable, CliRenderer } from "@opentui/core";
import type { SidebarViewController } from "./tui-view.js";
import { createV2SidebarFocus } from "./tui-v2-focus.js";

function fixture() {
  let route = "ses_parent", mode = "base", mounted = true, focused = false;
  const prompt = { visible: true, isDestroyed: false, focus: vi.fn(), blur: vi.fn() };
  const list = { visible: true, isDestroyed: false, focus: vi.fn(), blur: vi.fn() };
  const renderer = { currentFocusedRenderable: prompt, currentFocusedEditor: prompt };
  const view: SidebarViewController = {
    snapshotScroll: vi.fn(),
    focusList: vi.fn(() => { focused = true; list.focus(); return true; }),
    blurList: vi.fn(() => { const was = focused; focused = false; list.blur(); return was; }),
    isListFocused: () => focused, toggleCompletedHistory: () => mounted,
    target: () => mounted ? list as unknown as BoxRenderable : undefined,
    dispose: vi.fn(),
  };
  const unavailable = vi.fn();
  const focus = createV2SidebarFocus({
    renderer: renderer as unknown as Pick<CliRenderer, "currentFocusedRenderable" | "currentFocusedEditor">,
    view, route: () => route, mode: () => mode, unavailable,
  });
  return { focus, view, prompt, list, renderer, unavailable,
    route(value: string) { route = value; }, mode(value: string) { mode = value; },
    unmount() { mounted = false; },
  };
}
afterEach(() => vi.useRealTimers());

describe("V2 public focus ownership", () => {
  it("refuses modal input, absent/hidden targets and unsafe return targets", () => {
    const f = fixture();
    f.mode("modal"); f.focus.request("keyboard");
    f.mode("base"); f.list.visible = false; f.focus.request("keyboard");
    f.list.visible = true; f.prompt.isDestroyed = true; f.focus.request("keyboard");
    f.prompt.isDestroyed = false; f.prompt.visible = false; f.focus.request("keyboard");
    f.unmount(); f.focus.request("keyboard");
    expect(f.view.focusList).not.toHaveBeenCalled();
    expect(f.prompt.blur).not.toHaveBeenCalled();
    f.focus.dispose();
  });

  it("returns once to the live same-route editor even if the view already blurred on Esc", () => {
    const f = fixture();
    f.focus.request("keyboard");
    expect(f.view.focusList).toHaveBeenCalledOnce();
    f.view.blurList(); f.focus.leave(); f.focus.leave();
    expect(f.prompt.focus).toHaveBeenCalledOnce();
    f.focus.dispose();
  });

  it.each(["beforeNavigate", "routeChanged"] as const)("%s releases without restoring a previous prompt", (action) => {
    const f = fixture();
    f.focus.request("keyboard");
    f.focus[action](); f.route("ses_child"); f.focus.leave();
    expect(f.prompt.focus).not.toHaveBeenCalled();
    expect(f.view.isListFocused()).toBe(false);
    f.focus.dispose();
  });

  it("never restores a destroyed, hidden or modal editor", () => {
    const f = fixture();
    f.focus.request("keyboard"); f.prompt.isDestroyed = true; f.focus.leave();
    f.prompt.isDestroyed = false; f.focus.request("keyboard"); f.prompt.visible = false; f.focus.leave();
    f.prompt.visible = true; f.focus.request("keyboard"); f.mode("modal"); f.focus.leave();
    expect(f.prompt.focus).not.toHaveBeenCalled();
    f.focus.dispose();
  });

  it("waits for palette handoff and captures the restored editor rather than the modal editor", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const normal = { ...f.prompt, focus: vi.fn() };
    f.mode("modal"); f.focus.request("palette");
    await vi.advanceTimersByTimeAsync(60);
    expect(f.view.focusList).not.toHaveBeenCalled();
    f.mode("base"); f.renderer.currentFocusedEditor = normal;
    await vi.advanceTimersByTimeAsync(30);
    expect(f.view.focusList).toHaveBeenCalledOnce();
    f.focus.leave();
    expect(normal.focus).toHaveBeenCalledOnce();
    expect(f.prompt.focus).not.toHaveBeenCalled();
    f.focus.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds unavailable palette work to ten nonzero attempts with one feedback", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.mode("modal"); f.focus.request("palette");
    await vi.advanceTimersByTimeAsync(299);
    expect(f.unavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.unavailable).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.view.focusList).not.toHaveBeenCalled();
    f.focus.dispose();
  });

  it("does not capture the known modal editor while base mode precedes focus restoration", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.mode("modal"); f.focus.request("palette");
    f.mode("base"); await vi.advanceTimersByTimeAsync(30);
    expect(f.view.focusList).not.toHaveBeenCalled();
    const normal = { ...f.prompt, focus: vi.fn() };
    f.renderer.currentFocusedEditor = normal;
    await vi.advanceTimersByTimeAsync(30);
    expect(f.view.focusList).toHaveBeenCalledOnce();
    f.focus.leave(); expect(normal.focus).toHaveBeenCalledOnce();
    expect(f.prompt.focus).not.toHaveBeenCalled();
    f.focus.dispose();
  });

  it.each(["route", "unmount", "dispose"])("cancels pending palette work on %s", async (change) => {
    vi.useFakeTimers();
    const f = fixture(); f.mode("modal"); f.focus.request("palette");
    if (change === "route") { f.route("ses_child"); f.focus.routeChanged(); }
    if (change === "unmount") f.unmount();
    if (change === "dispose") f.focus.dispose();
    f.mode("base"); await vi.runAllTimersAsync();
    expect(f.view.focusList).not.toHaveBeenCalled();
    expect(f.prompt.focus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.focus.dispose();
  });

  it("restores owned live focus on disposal but never reacquires after disposal", () => {
    const f = fixture(); f.focus.request("keyboard");
    f.focus.dispose(); f.focus.dispose(); f.focus.request("keyboard");
    expect(f.prompt.focus).toHaveBeenCalledOnce();
    expect(f.view.focusList).toHaveBeenCalledOnce();
  });
});
