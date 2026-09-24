import type { CliRenderer, Renderable } from "@opentui/core";
import type { SidebarViewController } from "./tui-view.js";
import { V2_FOCUS_MAX_ATTEMPTS, V2_FOCUS_RETRY_DELAY_MS } from "./internal-policy.js";

export interface V2SidebarFocus {
  request(source: "keyboard" | "palette"): void;
  leave(): void;
  beforeNavigate(): void;
  routeChanged(): void;
  dispose(): void;
}

export function createV2SidebarFocus(input: {
  renderer: Pick<CliRenderer, "currentFocusedRenderable" | "currentFocusedEditor">;
  view: SidebarViewController;
  route: () => string;
  mode: () => string;
  unavailable: () => void;
}): V2SidebarFocus {
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saved: { target: Renderable; route: string } | undefined;
  const live = (target: Renderable | null | undefined): target is Renderable =>
    Boolean(target && !target.isDestroyed && target.visible);

  function cancel() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
  }
  function release(restore: boolean) {
    cancel();
    const previous = saved;
    saved = undefined;
    input.view.blurList();
    if (restore && previous && previous.route === input.route() &&
      input.mode() === "base" && live(previous.target)) previous.target.focus();
  }
  function transfer(excluded?: Renderable | null): boolean {
    const target = input.view.target();
    if (disposed || input.mode() !== "base" || !live(target)) return false;
    if (input.view.isListFocused()) return true;
    const candidate = input.renderer.currentFocusedEditor ?? input.renderer.currentFocusedRenderable;
    if (!live(candidate) || candidate === target || candidate === excluded) return false;
    const previous = { target: candidate, route: input.route() };
    if (!input.view.focusList()) return false;
    saved = previous;
    return true;
  }
  return {
    request(source) {
      if (disposed) return;
      cancel();
      if (source === "keyboard") {
        if (input.mode() === "base") transfer();
        return;
      }
      const target = input.view.target();
      if (!live(target)) { input.unavailable(); return; }
      const route = input.route(), token = generation;
      const modalTarget = input.mode() !== "base"
        ? input.renderer.currentFocusedEditor ?? input.renderer.currentFocusedRenderable : undefined;
      let attempts = 0;
      const attempt = () => {
        timer = undefined;
        if (disposed || token !== generation || route !== input.route()) return;
        // A remounted list is a different owner, even on the same route.
        if (input.view.target() !== target || !live(target)) return;
        if (transfer(modalTarget)) return;
        if (++attempts === V2_FOCUS_MAX_ATTEMPTS) { input.unavailable(); return; }
        timer = setTimeout(attempt, V2_FOCUS_RETRY_DELAY_MS);
      };
      // Dialog focus restoration is asynchronous even if its mode already reads base.
      timer = setTimeout(attempt, V2_FOCUS_RETRY_DELAY_MS);
    },
    leave: () => release(true),
    beforeNavigate: () => release(false),
    routeChanged: () => release(false),
    dispose() {
      if (disposed) return;
      disposed = true;
      release(true);
    },
  };
}
