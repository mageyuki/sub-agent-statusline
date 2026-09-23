import type { Context, KeymapLayer, Route, SlotClaim } from "@opencode/plugin/tui/context";
import type { OpenCodeEvent, SessionInfo } from "@opencode/client";
import { RGBA, type TextareaRenderable } from "@opentui/core";
import { createElement, insert, setProp, testRender } from "@opentui/solid";
import { createComponent, createSignal, For, onCleanup, Show } from "solid-js";
import { vi } from "vitest";
import { childInfo } from "./v2-fixtures.js";

export const hasNativeFFI = (() => {
  try { return Boolean(process.getBuiltinModule("node:ffi")); } catch { return false; }
})();

// This is a strict recorder of the small public boundary the plugin consumes,
// not a host dispatcher. Every supplied method is checked against official types;
// unmodelled host API access fails instead of silently succeeding.
function boundary<T extends object>(supplied: Partial<T>): T {
  return new Proxy(supplied, {
    get(target, key, receiver) {
      if (!(key in target)) throw new Error(`Unrecorded host API: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  }) as T;
}

export async function createV2ContextHarness() {
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "ses_parent" });
  const [mode, setMode] = createSignal("base");
  const [mounted, setMounted] = createSignal(false);
  const [sidebar, setSidebar] = createSignal(true);
  const [claims, setClaims] = createSignal<SlotClaim[]>([]);
  const handlers = new Set<(event: { details: OpenCodeEvent }) => void>();
  const layers = new Set<() => KeymapLayer>();
  const [infos, setInfos] = createSignal<SessionInfo[]>([childInfo(), childInfo({ id: "ses_parent", parentID: undefined })]);
  const reads = {
    get: vi.fn<Context["client"]["session"]["get"]>(async ({ sessionID }) => {
      const info = infos().find(item => item.id === sessionID);
      if (!info) throw new Error("Missing fixture session");
      return info;
    }),
    list: vi.fn<Context["client"]["session"]["list"]>(async input => ({
      data: infos().filter(item => item.parentID === input?.parentID), cursor: {},
    })),
    active: vi.fn<Context["client"]["session"]["active"]>(async () => ({ ses_child: { type: "running" } })),
  };
  const messageList = vi.fn<Context["data"]["session"]["message"]["list"]>(() => []);
  const modelList = vi.fn<Context["data"]["location"]["model"]["list"]>(() => []);
  const toast = vi.fn<Context["ui"]["toast"]["show"]>();
  const navigate = vi.fn<Context["ui"]["router"]["navigate"]>();
  const stored: Array<{ key: string; value: object }> = [];
  const mutations: object[] = [];
  const updateFailure = { error: undefined as Error | undefined };
  const storage: Context["storage"] = boundary<Context["storage"]>({
    store<Value extends object>(key: string, options: { initial: Value }) {
      // Only the small presentation object is recorded; persistence is host-owned.
      const [snapshot, setSnapshot] = createSignal(structuredClone(options.initial));
      const value = new Proxy(options.initial, { get: (_target, key) => Reflect.get(snapshot(), key) });
      stored.push({ key, value });
      return [value, async (mutation: (draft: Value) => void) => {
        if (updateFailure.error) throw updateFailure.error;
        const next = structuredClone(snapshot()); mutation(next); setSnapshot(() => next);
        mutations.push(JSON.parse(JSON.stringify(value)) as object);
      }] as const;
    },
  });
  let prompt!: TextareaRenderable;
  const [promptGeneration, setPromptGeneration] = createSignal(1);
  const content = () => createComponent(Show, {
    keyed: true,
    get when() { return mounted(); },
    get children() {
      return createComponent(For, {
        get each() { return claims(); },
        children: (claim: SlotClaim) => {
          if (claim.append === "app") return claim.render({});
          if (claim.append === "sidebar.content") return createComponent(Show, {
            get when() { const current = route(); return sidebar() && current.type === "session" ? current.sessionID : undefined; },
            keyed: true,
            children: (sessionID: string) => claim.render({ sessionID }),
          });
          if (claim.append === "home.footer.status") return createComponent(Show, {
            keyed: true,
            get when() { return route().type === "home"; },
            get children() { return claim.render({}); },
          });
          throw new Error("Only approved additive slots are recorded");
        },
      });
    },
  });
  const setup = await testRender(() => {
    const editor = () => createComponent(Show, {
      get when() { return promptGeneration(); }, keyed: true,
      children: (_generation: number) => {
        prompt = createElement("textarea") as TextareaRenderable;
        setProp(prompt, "width", 40); setProp(prompt, "height", 2);
        return prompt;
      },
    });
    // Separate real containers mirror host slot/prompt ownership. Dynamic slot
    // insertion must not remove/reinsert the sibling editor (which blurs it).
    const slots = createElement("box"), composer = createElement("box");
    setProp(slots, "flexDirection", "column");
    insert(slots, content); insert(composer, editor);
    return [slots, composer];
  }, { width: 64, height: 45 });
  prompt.focus();
  const color = (hex: string) => RGBA.fromHex(hex);
  const theme: Context["theme"] = boundary<Context["theme"]>({
    text: boundary<Context["theme"]["text"]>({ base: color("#eeeeee"), muted: color("#999999"),
      feedback: boundary<Context["theme"]["text"]["feedback"]>({
        warning: { base: color("#ffff00"), muted: color("#aaaa00") },
        success: { base: color("#00ff00"), muted: color("#00aa00") },
        error: { base: color("#ff0000"), muted: color("#aa0000") },
      }),
    }),
    hue: boundary<Context["theme"]["hue"]>({ accent: boundary<Context["theme"]["hue"]["accent"]>({ 500: color("#5555ff") }) }),
    background: boundary<Context["theme"]["background"]>({
      raised: { base: color("#222222"), high: color("#333333"), max: color("#444444") },
    }),
  });
  let slotCalls = 0;
  const failures = { slot: 0, disposeSlot: false, unsubscribe: false };
  const context: Context = boundary<Context>({
    renderer: setup.renderer, theme, storage,
    client: boundary<Context["client"]>({ session: boundary<Context["client"]["session"]>(reads) }),
    data: boundary<Context["data"]>({
      listen(handler) { handlers.add(handler); return () => { handlers.delete(handler); if (failures.unsubscribe) throw new Error("PRIVATE unsubscribe failure"); }; },
      on(type, handler) {
        const read = ({ details }: { details: OpenCodeEvent }) => {
          // The public discriminant guarantees this indexed event type.
          if (details.type === type) handler(details as Parameters<typeof handler>[0]);
        };
        handlers.add(read); return () => { handlers.delete(read); };
      },
      session: boundary<Context["data"]["session"]>({
        list: infos, get: id => infos().find(item => item.id === id),
        sync: vi.fn(async () => {}), invalidate: vi.fn(),
        message: { list: messageList, get: () => undefined, sync: vi.fn(async () => {}), invalidate: vi.fn() },
      }),
      location: boundary<Context["data"]["location"]>({ model: { list: modelList, sync: vi.fn(async () => {}), invalidate: vi.fn() } }),
    }),
    keymap: boundary<Context["keymap"]>({
      layer(read) { layers.add(read); onCleanup(() => layers.delete(read)); },
      mode: boundary<Context["keymap"]["mode"]>({ current: mode }),
    }),
    ui: boundary<Context["ui"]>({
      toast: { show: toast }, router: boundary<Context["ui"]["router"]>({ current: route, navigate }),
      slot(claim) {
        if (++slotCalls === failures.slot) throw new Error("Original slot failure");
        if (!["app", "sidebar.content", "home.footer.status"].includes(claim.append ?? "")) throw new Error("Unexpected slot");
        setClaims(all => [...all, claim]);
        return () => {
          setClaims(all => all.filter(item => item !== claim));
          if (failures.disposeSlot) throw new Error("PRIVATE slot disposal failure");
        };
      },
    }),
  });
  return {
    ...setup, context, get prompt() { return prompt; }, reads, messageList, modelList, toast, navigate,
    replacePrompt() { setPromptGeneration(value => value + 1); prompt.focus(); },
    stored, mutations, failures, updateFailure, setInfos, setRoute, setMode, setSidebar,
    emit(event: OpenCodeEvent) { for (const handler of handlers) handler({ details: event }); },
    mount() { setMounted(true); }, unmount() { setMounted(false); },
    activeHandlers: () => handlers.size, activeClaims: () => claims().length,
    layers: () => [...layers].map(read => read()),
    slotPaths: () => claims().map(claim => claim.append!),
  };
}
