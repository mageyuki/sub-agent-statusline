import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import type { BoxRenderable, KeyEvent } from "@opentui/core";
import { batch, createEffect, createRoot, createSignal, onCleanup, Show, untrack } from "solid-js";
import { createEmptyState, type ChildSessionState } from "./state.js";
import { truncateToColumns } from "./text-width.js";
import { t } from "./i18n.js";
import { createV2Monitor, type V2Monitor } from "./tui-v2-state.js";
import { createV2SnapshotWriter, resolveV2SnapshotPaths, type V2SnapshotWriter } from "./tui-v2-snapshot.js";
import { createV2SidebarFocus, type V2SidebarFocus } from "./tui-v2-focus.js";
import {
  createSidebarViewController, HomeBottomStatus, SidebarSubagents,
  type MonitorTheme, type SidebarChildNavigation, type SidebarViewController, type SidebarViewProps,
} from "./tui-view.js";

async function initializeV2(context: Context): Promise<Plugin.Cleanup> {
  let disposed = false;
  let cleanupPromise: Promise<void> | undefined;
  let disposeRoot: (() => void) | undefined;
  let hide: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let navigationGeneration = 0;
  let view: SidebarViewController | undefined;
  let focus: V2SidebarFocus | undefined;
  let monitor: V2Monitor | undefined;
  let writer: V2SnapshotWriter | undefined;
  const subscriptions: Array<() => void> = [];
  const claims: Array<() => void> = [];
  const reported = new Set<string>();
  function report(message: string) {
    if (reported.has(message)) return;
    reported.add(message);
    try { context.ui.toast.show({ message, variant: "warning" }); } catch { /* Host may already be closing. */ }
  }
  function issue(message: string) { if (!disposed) report(message); }
  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    disposed = true;
    navigationGeneration++;
    cleanupPromise = (async () => {
      let failed = false;
      const release = (action: (() => void) | undefined) => {
        try { action?.(); } catch { failed = true; }
      };
      release(() => monitor?.dispose());
      release(() => clearInterval(tick));
      for (const stop of subscriptions.splice(0)) release(stop);
      release(() => focus?.dispose());
      // Remove component-owned layers even if a host claim disposer itself fails.
      release(hide);
      for (const remove of claims.splice(0).reverse()) release(remove);
      release(() => view?.dispose());
      release(disposeRoot);
      try { await writer?.dispose(); } catch { failed = true; }
      if (failed) report("Subagents: Cleanup incomplete");
    })();
    return cleanupPromise;
  }

  try {
    createRoot(dispose => {
      disposeRoot = dispose;
      const [alive, setAlive] = createSignal(true);
      hide = () => setAlive(false);
      const [state, setState] = createSignal(createEmptyState());
      const [nowMs, setNowMs] = createSignal(Date.now());
      const [stale, setStale] = createSignal(false);
      const [preferences, updatePreferences] = context.storage.store("subagents.sidebar", {
        initial: { enabled: true, expanded: true },
      });
      const theme: MonitorTheme = {
        get text() { return context.theme.text.base; },
        get textMuted() { return context.theme.text.muted; },
        get accent() { return context.theme.hue.accent[500]; },
        get warning() { return context.theme.text.feedback.warning.base; },
        get success() { return context.theme.text.feedback.success.base; },
        get error() { return context.theme.text.feedback.error.base; },
        get backgroundElement() { return context.theme.background.raised.high; },
        get backgroundPanel() { return context.theme.background.raised.base; },
      };
      const ownedView = view = createSidebarViewController();
      const routeKey = () => {
        const route = context.ui.router.current();
        return route.type === "session" ? `session:${route.sessionID}` :
          route.type === "plugin" ? `plugin:${route.id}:${route.name}` : "home";
      };
      const ownedFocus = focus = createV2SidebarFocus({
        renderer: context.renderer, view: ownedView, route: routeKey,
        mode: () => context.keymap.mode.current(),
        unavailable: () => { if (!disposed) context.ui.toast.show({ message: t("unavailable"), variant: "info" }); },
      });
      const ownedWriter = writer = createV2SnapshotWriter({
        ...resolveV2SnapshotPaths(), onIssue: () => issue("Subagents: Snapshot unavailable"),
      });
      const ownedMonitor = monitor = createV2Monitor({
        session: context.client.session, cache: context.data.session,
        onIssue: () => issue(t("stale")),
        onChange(next) {
          if (disposed) return;
          ownedView.snapshotScroll();
          batch(() => { setState(next); setStale(ownedMonitor.stale()); setNowMs(Date.now()); });
          ownedWriter.enqueue(next);
          const running = Object.values(next.children).some(child => child.status === "running");
          if (running && !tick) tick = setInterval(() => { if (!disposed) setNowMs(Date.now()); }, 1_000);
          if (!running && tick) { clearInterval(tick); tick = undefined; }
        },
      });
      const run = (work: Promise<void>) => { void work.catch(() => issue(t("stale"))); };
      let restore: SidebarChildNavigation | undefined;
      let intent: SidebarChildNavigation | undefined;
      async function navigate(target: string | undefined) {
        const selected = intent;
        intent = undefined;
        if (disposed || !target || !selected || selected.childSessionID !== target) return;
        const token = ++navigationGeneration, route = routeKey();
        const valid = () => !disposed && token === navigationGeneration && routeKey() === route &&
          state().children[selected.childRowID]?.parentID === selected.parentSessionID;
        if (!valid()) return;
        try {
          const info = await context.client.session.get({ sessionID: target });
          if (!valid() || info.id !== target || info.parentID !== selected.parentSessionID) return;
          restore = selected;
          ownedFocus.beforeNavigate();
          context.ui.router.navigate({ type: "session", sessionID: target });
        } catch { /* A missing/deleted/inaccessible target is not navigable. */ }
      }
      async function preference(mutate: (draft: { enabled: boolean; expanded: boolean }) => void) {
        if (disposed) return;
        try { await updatePreferences(mutate); }
        catch { issue("Subagents: Preferences unavailable"); }
      }
      const toggleFocus = () => {
        if (disposed || context.keymap.mode.current() !== "base" || !preferences.enabled) return false;
        if (ownedView.isListFocused()) ownedFocus.leave();
        else {
          const target = ownedView.target();
          if (!target || target.isDestroyed || !target.visible) return false;
          ownedFocus.request("keyboard");
        }
      };
      function Commands() {
        context.keymap.layer(() => ({ mode: "global", commands: [
          { id: "subagent-statusline.toggle-sidebar-section", title: "Subagents: Toggle sidebar section",
            description: "Toggle the entire subagent sidebar section", group: "Subagents", palette: true, bind: false,
            run: () => {
              if (disposed) return;
              if (preferences.enabled) ownedFocus.leave();
              return preference(draft => { draft.enabled = !draft.enabled; });
            } },
          { id: "subagent-statusline.focus-sidebar-list", title: "Subagents: Focus sidebar list",
            description: "Focus the subagent sidebar list for keyboard navigation", group: "Subagents", palette: true, bind: false,
            run: () => { if (!disposed) ownedFocus.request("palette"); } },
          { id: "subagent-statusline.toggle-completed-history", title: "Subagents: Toggle completed history",
            description: "Toggle retained completed rows in the subagent sidebar. Shortcut: c while the sidebar list is focused.",
            group: "Subagents", palette: true, bind: false,
            run: () => { if (!disposed && !ownedView.toggleCompletedHistory()) issue(t("unavailable")); } },
        ] }));
        context.keymap.layer(() => ({ mode: "base", priority: 100, commands: [{
          bind: "alt+b", run: (_input, event) => {
            if (event && (event.ctrl || event.shift || event.super || event.hyper ||
              !(event.meta || event.option) || event.name.toLowerCase() !== "b")) return false;
            if (toggleFocus() === false) return false;
            event?.preventDefault(); event?.stopPropagation();
          },
        }] }));
        return null;
      }
      const registerListKeys: SidebarViewProps["registerListKeys"] = ({ target, onKeyDown }) => {
        context.keymap.layer(() => ({ mode: "base", priority: 100, target, commands:
          ["j", "k", "up", "down", "return", "c", "h", "l", "left", "right", "escape", "alt+b"].map(bind => ({
            bind, run: (_input?: string, event?: KeyEvent) => {
              if (disposed || context.keymap.mode.current() !== "base" || !ownedView.isListFocused() || !event) return false;
              onKeyDown(event);
              if (!event.defaultPrevented) return false;
            },
          })),
        }));
      };
      function modelLine(child: ChildSessionState, width: number): string | undefined {
        if (!child.model?.variant) return undefined;
        const info = context.data.session.get(child.id);
        const model = info && context.data.location.model.list(info.location)?.find(candidate =>
          candidate.id === child.model?.modelID && candidate.providerID === child.model.providerID);
        return truncateToColumns(`${model?.name || child.model.modelID} · ${child.model.variant}`, Math.max(1, width));
      }
      function Sidebar(props: { sessionID: string }) {
        const [width, setWidth] = createSignal<number>();
        let element: BoxRenderable | undefined;
        const measure = () => {
          if (!element || element.isDestroyed || element.width <= 0 || element.width === width()) return;
          ownedView.snapshotScroll(); setWidth(element.width);
        };
        onCleanup(() => {
          navigationGeneration++;
          element?.off("layout-changed", measure);
          element?.off("resized", measure);
          // Same-route unmount returns safe input; route changes never restore the old editor.
          ownedFocus.leave();
        });
        return <box flexDirection="column" ref={node => {
          element = node; node.on("layout-changed", measure); node.on("resized", measure); measure();
        }}>
          <SidebarSubagents controller={ownedView} sessionID={props.sessionID} state={state} nowMs={nowMs}
            expanded={() => preferences.expanded}
            onToggleExpanded={() => { void preference(draft => { draft.expanded = !draft.expanded; }); }}
            onSetExpanded={expanded => { void preference(draft => { draft.expanded = expanded; }); }}
            onReturnFocus={() => ownedFocus.leave()} onToggleListFocus={toggleFocus}
            onNavigateToChild={next => { intent = next; }} navigate={target => { void navigate(target); }}
            modelLine={modelLine} registerListKeys={registerListKeys} sidebarWidth={width} theme={theme}
            restoreFromChild={restore?.parentSessionID === props.sessionID ? restore : undefined}
            notice={() => stale() ? t("stale") : undefined}
            childHint={id => { state(); return ownedMonitor.hint(id) ? t("interrupted") : undefined; }}
            usageLabel={t("usage")} strictInput />
        </box>;
      }
      subscriptions.push(context.data.listen(({ details }) => {
        if (disposed) return;
        if (details.type === "server.connected") run(ownedMonitor.reconnect());
        else run(ownedMonitor.accept(details));
      }));
      claims.push(context.ui.slot({ append: "app", render: () => <Show when={alive()}><Commands /></Show> }));
      claims.push(context.ui.slot({ append: "sidebar.content", render: input => (
        <Show when={alive() && preferences.enabled}>
          <Show when={input.sessionID} keyed>{(sessionID: string) => <Sidebar sessionID={sessionID} />}</Show>
        </Show>
      ) }));
      claims.push(context.ui.slot({ append: "home.footer.status", render: () => (
        <Show when={alive()}><HomeBottomStatus state={state} theme={theme} /></Show>
      ) }));
      let previousRoute: string | undefined;
      createEffect(() => {
        const route = context.ui.router.current(), key = routeKey();
        if (key === previousRoute) return;
        previousRoute = key;
        navigationGeneration++; intent = undefined;
        ownedFocus.routeChanged();
        if (restore && (route.type !== "session" ||
          (route.sessionID !== restore.parentSessionID && route.sessionID !== restore.childSessionID))) restore = undefined;
        untrack(() => run(ownedMonitor.refresh(route.type === "session" ? route.sessionID : undefined)));
      });
    });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export default Plugin.define({ id: "subagent-statusline.tui", setup: initializeV2 });
