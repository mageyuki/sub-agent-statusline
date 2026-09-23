import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyEvent, RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createComponent, createSignal, onCleanup, Show } from "solid-js";
import type { ChildSessionState, StatuslineState } from "./state.js";
import {
  createSidebarViewController,
  HomeBottomStatus,
  preservedSidebarAnchorScrollTop,
  SidebarSubagents,
  type MonitorTheme,
  type SidebarViewController,
  type SidebarViewProps,
} from "./tui-view.js";

const NOW = Date.parse("2026-04-30T10:20:00.000Z");
// OpenTUI's native renderer needs node:ffi, absent on the baseline Node 22/24.
// The required native lane runs these assertions on Node 26 with --experimental-ffi.
const hasNativeFFI = (() => {
  try {
    return Boolean(process.getBuiltinModule("node:ffi"));
  } catch {
    return false;
  }
})();
function child(overrides: Partial<ChildSessionState> = {}): ChildSessionState {
  return {
    id: "ses_child", title: "Child work", parentID: "ses_parent",
    source: "session", targetSessionID: "ses_child", status: "running",
    color: "yellow", startedAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:01:00.000Z", ...overrides,
  };
}
function stateWith(children: ChildSessionState[]): StatuslineState {
  return {
    children: Object.fromEntries(children.map((item) => [item.id, item])),
    countedChildIDs: Object.fromEntries(children
      .filter((item) => item.source === "session" || item.id.startsWith("ses_"))
      .map((item) => [item.targetSessionID ?? item.id, true])),
    totalExecuted: 99, updatedAt: "2026-04-30T10:20:00.000Z",
  };
}
const theme: MonitorTheme = {
  text: RGBA.fromHex("#eeeeee"), textMuted: RGBA.fromHex("#999999"),
  accent: RGBA.fromHex("#5555ff"), warning: RGBA.fromHex("#ffff00"),
  success: RGBA.fromHex("#00ff00"), error: RGBA.fromHex("#ff0000"),
  backgroundElement: RGBA.fromHex("#222222"), backgroundPanel: RGBA.fromHex("#333333"),
};
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function mountSidebar(controller: SidebarViewController, children = [child()]) {
  const [state, setState] = createSignal(stateWith(children));
  const [mounted, setMounted] = createSignal(true);
  const [expanded, setExpanded] = createSignal(true);
  let keys: Parameters<SidebarViewProps["registerListKeys"]>[0] | undefined;
  const navigate = vi.fn();
  const onNavigateToChild = vi.fn();
  const onReturnFocus = vi.fn();
  const onToggleListFocus = vi.fn();
  const modelLine = vi.fn((item: ChildSessionState, _width: number) =>
    item.model?.variant ? "Visible model · high" : undefined);
  const setup = await testRender(() => createComponent(Show, {
    get when() { return mounted(); },
    get children() {
      return createComponent(SidebarSubagents, {
        controller, sessionID: "ses_parent", state, nowMs: () => NOW,
        expanded, onToggleExpanded: () => setExpanded(!expanded()),
        onSetExpanded: setExpanded, onReturnFocus, onToggleListFocus,
        onNavigateToChild, navigate, modelLine, theme, sidebarWidth: () => 40,
        registerListKeys(input) {
          keys = input;
          onCleanup(() => { keys = undefined; });
        },
      });
    },
  }), { width: 40, height: 35 });
  cleanups.push(() => setup.renderer.destroy());
  // Native text measurement can schedule another layout pass (e.g. model lines).
  // Observe the settled frame, not just the first paint.
  await setup.flush();
  return {
    ...setup, setState, setMounted, expanded, navigate, onNavigateToChild,
    onReturnFocus, onToggleListFocus, modelLine, keys: () => keys,
    key(name: string) {
      const event = new KeyEvent({ name, sequence: name, ctrl: false, meta: false,
        shift: false, option: false, number: false, raw: name, eventType: "press" });
      keys?.onKeyDown(event);
      return event;
    },
  };
}

describe("shared sidebar view ownership", () => {
  it("owns empty registrations independently and disposes idempotently", () => {
    const first = createSidebarViewController();
    const second = createSidebarViewController();
    expect(first).not.toBe(second);
    expect(first.focusList()).toBe(false);
    expect(first.target()).toBeUndefined();
    first.dispose();
    first.dispose();
    expect(second.isListFocused()).toBe(false);
    expect(second.toggleCompletedHistory()).toBe(false);
    second.dispose();
  });

  it.skipIf(!hasNativeFFI)("scopes mounted focus/history to each controller and unregisters on unmount", async () => {
    const first = createSidebarViewController();
    const second = createSidebarViewController();
    const rows = [child(), child({ id: "ses_old", targetSessionID: "ses_old",
      title: "Old completed work", status: "done", color: "green",
      endedAt: "2026-04-30T10:02:00.000Z", updatedAt: "2026-04-30T10:02:00.000Z" })];
    const a = await mountSidebar(first, rows);
    const b = await mountSidebar(second, rows);
    expect(a.keys()?.target()).toBe(first.target());
    expect(b.keys()?.target()).toBe(second.target());
    expect(first.target()).not.toBe(second.target());
    expect(first.focusList()).toBe(true);
    expect(first.isListFocused()).toBe(true);
    expect(second.isListFocused()).toBe(false);
    expect(first.target()?.backgroundColor).toEqual(theme.backgroundPanel);
    expect(second.target()?.backgroundColor).not.toEqual(theme.backgroundPanel);
    expect(first.toggleCompletedHistory()).toBe(true);
    await a.renderOnce();
    await b.renderOnce();
    expect(a.captureCharFrame()).toContain("Old completed work");
    expect(b.captureCharFrame()).not.toContain("Old completed work");
    a.setMounted(false);
    expect(a.keys()).toBeUndefined();
    expect(first.target()).toBeUndefined();
    expect(first.focusList()).toBe(false);
    expect(first.toggleCompletedHistory()).toBe(false);
    expect(second.focusList()).toBe(true);
    second.dispose();
    second.dispose();
    expect(second.target()).toBeUndefined();
    expect(second.isListFocused()).toBe(false);
    expect(second.focusList()).toBe(false);
    expect(second.toggleCompletedHistory()).toBe(false);
    b.setMounted(false);
    b.setMounted(true);
    expect(second.target()).toBeUndefined();
    expect(second.focusList()).toBe(false);
    first.dispose();
  });

  it.skipIf(!hasNativeFFI)("uses view callbacks for selection, model labels, expansion and prompt return", async () => {
    const controller = createSidebarViewController();
    const a = await mountSidebar(controller, [child(), child({ id: "ses_second",
      targetSessionID: "ses_second", title: "Second work",
      model: { providerID: "test", modelID: "model", variant: "high" } })]);
    expect(a.captureCharFrame()).toContain("Visible model · high");
    expect(a.modelLine).toHaveBeenCalledWith(expect.objectContaining({ id: "ses_second" }), 32);
    a.key("return");
    expect(a.navigate).not.toHaveBeenCalled();
    controller.focusList("ses_child");
    a.key("j");
    a.key("return");
    expect(a.onNavigateToChild).toHaveBeenCalledWith({ parentSessionID: "ses_parent",
      childSessionID: "ses_second", childRowID: "ses_second", showCompletedHistory: false });
    expect(a.navigate).toHaveBeenCalledWith("ses_second");
    a.key("h");
    expect(a.expanded()).toBe(false);
    a.key("l");
    expect(a.expanded()).toBe(true);
    a.key("escape");
    expect(controller.isListFocused()).toBe(false);
    expect(a.onReturnFocus).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it.skipIf(!hasNativeFFI)("snapshots only owned scrollboxes before reactive row-height changes", async () => {
    const first = createSidebarViewController();
    const second = createSidebarViewController();
    const rows = Array.from({ length: 14 }, (_, index) => child({
      id: `ses_${index}`, targetSessionID: `ses_${index}`, title: `Work ${index}` }));
    const a = await mountSidebar(first, rows);
    const b = await mountSidebar(second, rows);
    const aScroll = first.target()!.getChildren().find((node) => node.constructor.name === "ScrollBoxRenderable") as ScrollBoxRenderable;
    const bScroll = second.target()!.getChildren().find((node) => node.constructor.name === "ScrollBoxRenderable") as ScrollBoxRenderable;
    aScroll.scrollTop = 5;
    bScroll.scrollTop = 3;
    first.snapshotScroll();
    // A new secondary line above the anchor must shift its saved offset by one.
    a.setState(stateWith(rows.map((row, index) => index === 0 ? { ...row, agentName: "reviewer" } : row)));
    await a.renderOnce();
    expect(aScroll.scrollTop).toBe(6);
    // Reset without a snapshot: the other controller must not restore A's work.
    bScroll.scrollTop = 0;
    await b.renderOnce();
    expect(bScroll.scrollTop).toBe(0);
    first.dispose();
    second.dispose();
  });

  it("retains a visible row anchor when a preceding row changes height", () => {
    expect(preservedSidebarAnchorScrollTop({
      expanded: true, anchor: { childIDs: ["ses_b"], intraRowOffset: 1 },
      rows: [{ id: "ses_a", height: 4 }, { id: "ses_b", height: 3 }],
      scrollTop: 0, scrollHeight: 7, viewportHeight: 2,
    })).toBe(5);
  });

  it.skipIf(!hasNativeFFI)("renders home counts from classified children rather than the stored total", async () => {
    const setup = await testRender(() => createComponent(HomeBottomStatus, {
      theme, state: () => stateWith([child(), child({ id: "ses_done", targetSessionID: "ses_done",
        status: "done", color: "green" }), child({ id: "tool:wrapper", source: "tool",
        targetSessionID: undefined, toolName: "delegate" })]),
    }), { width: 40, height: 5 });
    cleanups.push(() => setup.renderer.destroy());
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("● 1 · ✓ 1 · ✕ 0 · Σ 2");
  });
});
