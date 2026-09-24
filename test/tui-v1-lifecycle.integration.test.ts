import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { BoxRenderable, RGBA, TextRenderable, type Renderable } from "@opentui/core";
import { createElement, insert, testRender } from "@opentui/solid";
import { createComponent, createMemo, createSignal, Show } from "solid-js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import v1Plugin from "../src/tui-v1.js";

const hasNativeFFI = (() => {
  try { return Boolean(process.getBuiltinModule("node:ffi")); } catch { return false; }
})();
type Event = Parameters<Parameters<TuiPluginApi["event"]["on"]>[1]>[0];
type Commands = NonNullable<TuiPluginApi["command"]>;

// Record only the public host boundary. Solid, OpenTUI, the registered slot,
// plugin state/maintenance and keyboard listeners all execute unchanged.
function boundary<T extends object>(supplied: Partial<T>): T {
  return new Proxy(supplied, {
    get(target, key, receiver) {
      if (!(key in target)) throw new Error(`Unrecorded V1 host API: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  }) as T;
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  // Advance production maintenance without replacing native renderer timers.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const dir = await mkdtemp(join(tmpdir(), "subagent-v1-slot-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE = join(dir, "state.json");
  vi.stubEnv("XDG_DATA_HOME", dir);
  vi.stubEnv("XDG_RUNTIME_DIR", dir);
  vi.stubEnv("OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS", "");
  vi.stubEnv("OPENCODE_SUBAGENT_STATUSLINE_OPENCODE_DB", join(dir, "absent.db"));
  cleanups.push(() => { vi.unstubAllEnvs(); });
  const logDir = join(dir, "opencode", "log");
  await mkdir(logDir, { recursive: true });
  const handlers = new Set<(event: Event) => void>();
  const disposers: Array<() => void | Promise<void>> = [];
  let commands: Parameters<Commands["register"]>[0] | undefined;
  let slot: TuiSlotPlugin["slots"]["sidebar_content"];
  const theme = boundary<TuiPluginApi["theme"]>({
    current: boundary<TuiPluginApi["theme"]["current"]>({
      text: RGBA.fromHex("#eeeeee"), textMuted: RGBA.fromHex("#999999"),
      accent: RGBA.fromHex("#5555ff"), warning: RGBA.fromHex("#ffff00"),
      success: RGBA.fromHex("#00ff00"), error: RGBA.fromHex("#ff0000"),
      backgroundElement: RGBA.fromHex("#222222"), backgroundPanel: RGBA.fromHex("#333333"),
    }),
  });
  const session = boundary<TuiPluginApi["client"]["session"]>({
    children: async () => ({ data: [], error: undefined, request: new Request("http://fixture.invalid"), response: new Response() }),
    messages: async () => ({ data: [], error: undefined, request: new Request("http://fixture.invalid"), response: new Response() }),
    status: async () => ({ data: {}, error: undefined, request: new Request("http://fixture.invalid"), response: new Response() }),
  });
  const api = boundary<TuiPluginApi>({
    route: boundary<TuiPluginApi["route"]>({ current: { name: "session", params: { sessionID: "ses_parent" } } }),
    state: boundary<TuiPluginApi["state"]>({
      path: { directory: dir, worktree: dir, state: dir, config: dir }, provider: [],
      session: boundary<TuiPluginApi["state"]["session"]>({
        status: () => ({ type: "idle" }), messages: () => [],
      }),
      part: () => [],
    }),
    client: boundary<TuiPluginApi["client"]>({ session }),
    kv: boundary<TuiPluginApi["kv"]>({ get: <Value,>(_key: string, fallback?: Value) => fallback as Value, set: () => {} }),
    keymap: boundary<TuiPluginApi["keymap"]>({ registerLayer: undefined }),
    command: boundary<Commands>({ register(read) { commands = read; return () => { commands = undefined; }; } }),
    ui: boundary<TuiPluginApi["ui"]>({ toast: () => {}, dialog: boundary<TuiPluginApi["ui"]["dialog"]>({ clear: () => {} }) }),
    event: { on(type, handler) {
      const read = (event: Event) => {
        if (event.type === type) handler(event as Parameters<typeof handler>[0]);
      };
      handlers.add(read);
      return () => { handlers.delete(read); };
    } },
    lifecycle: boundary<TuiPluginApi["lifecycle"]>({ onDispose(fn) { disposers.push(fn); return () => {}; } }),
    slots: { register(plugin: TuiSlotPlugin) { slot = plugin.slots.sidebar_content; return "fixture-monitor"; } },
  });
  await v1Plugin.tui(api, undefined, {
    id: "subagent-statusline.tui", source: "file", spec: "fixture", target: "fixture",
    first_time: 0, last_time: 0, time_changed: 0, load_count: 1, fingerprint: "fixture", state: "first",
  });
  // Await the empty public client hydration before adding live event fixtures.
  await new Promise<void>(resolve => setImmediate(resolve));
  const emit = (event: Event) => { for (const handler of handlers) handler(event); };
  for (const [index, title] of ["Alpha work", "Beta work"].entries()) {
    emit({ id: `evt_${index}`, type: "session.created", properties: { sessionID: `ses_child_${index}`, info: {
      id: `ses_child_${index}`, parentID: "ses_parent", slug: `child-${index}`,
      projectID: "fixture", directory: dir, title, version: "1",
      time: { created: Date.now() - 1000 - index, updated: Date.now() - 1000 - index },
    } } });
    emit({ id: `evt_idle_${index}`, type: "session.idle", properties: { sessionID: `ses_child_${index}` } });
  }
  const [mounted, setMounted] = createSignal(true);
  let slotCalls = 0;
  const host = await testRender(() => {
    const container = createElement("box");
    insert(container, () => createComponent(Show, {
      keyed: true,
      get when() { return mounted(); },
      get children() {
        // V1 OpenTUI AppendEntry invokes the renderer in a tracked memo. Do not
        // untrack this call: doing so would mask the production lifetime defect.
        return createMemo(() => {
          slotCalls++;
          if (!slot) throw new Error("Production sidebar slot was not registered");
          const context = { theme, session_id: "ses_parent" };
          return slot(context, { session_id: "ses_parent" });
        });
      },
    }));
    return container;
  }, { width: 50, height: 35 });
  cleanups.push(() => host.renderer.destroy());
  const dispose = async () => {
    setMounted(false); // The host owns removal of registered slot components.
    for (const fn of disposers.splice(0)) await fn();
    await host.flush();
  };
  cleanups.push(dispose);
  await host.flush();
  return {
    ...host, dispose, handlers, slotCalls: () => slotCalls,
    // Delayed tokens arrive via the existing log fallback, not a private setter.
    hydrateTokens: () => writeFile(join(logDir, "fixture.log"), JSON.stringify({
      sessionID: "ses_child_1", tokens: { input: 12, output: 3, total: 15 },
    }) + "\n"),
    command(suffix: string) {
      const found = commands?.().find(item => item.value === `subagent-statusline.${suffix}`);
      if (!found?.onSelect) throw new Error(`Missing command: ${suffix}`);
      found.onSelect();
    },
    hasCommands: () => commands !== undefined,
  };
}

function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap(child => [child, ...descendants(child)]);
}
function selected(root: Renderable): string | undefined {
  const marker = descendants(root).find(node => node instanceof TextRenderable && node.plainText === "›");
  if (!marker?.parent) return undefined;
  return descendants(marker.parent)
    .find((node): node is TextRenderable => node instanceof TextRenderable && /Alpha work|Beta work/.test(node.plainText))?.plainText.trim();
}

describe.skipIf(!hasNativeFFI)("V1 registered slot ownership (requires node:ffi)", () => {
  it("keeps the same focused list and selected child through token maintenance, then cleans up enabled toggles", async () => {
    const host = await fixture();
    host.command("focus-sidebar-list");
    await vi.waitFor(() => expect(host.renderer.currentFocusedRenderable).toBeInstanceOf(BoxRenderable));
    const target = host.renderer.currentFocusedRenderable!;
    expect(selected(target)).toBe("Alpha work");
    await host.mockInput.typeText("j");
    await host.flush();
    expect(selected(target)).toBe("Beta work");
    const calls = host.slotCalls();
    await host.hydrateTokens();
    await vi.advanceTimersByTimeAsync(2000);
    await host.flush();
    expect(host.captureCharFrame()).toContain("15 ctx");
    expect(target.isDestroyed).toBe(false);
    expect(host.renderer.currentFocusedRenderable).toBe(target);
    expect(selected(target)).toBe("Beta work");
    expect(host.slotCalls()).toBe(calls);
    await host.mockInput.typeText("k");
    await host.flush();
    expect(selected(target)).toBe("Alpha work");
    await host.mockInput.typeText("j");
    await host.flush();
    expect(selected(target)).toBe("Beta work");

    const listeners = host.renderer.keyInput.listenerCount("keypress");
    host.command("toggle-sidebar-section");
    await host.flush();
    expect(target.isDestroyed).toBe(true);
    expect(host.captureCharFrame()).not.toContain("Subagents");
    expect(host.renderer.keyInput.listenerCount("keypress")).toBe(listeners - 1);
    host.command("toggle-sidebar-section");
    await host.flush();
    expect(host.captureCharFrame()).toContain("Beta work");
    expect(host.renderer.keyInput.listenerCount("keypress")).toBe(listeners);
    expect(host.slotCalls()).toBe(calls);
    host.command("focus-sidebar-list");
    await vi.waitFor(() => expect(host.renderer.currentFocusedRenderable).toBeInstanceOf(BoxRenderable));
    const replacement = host.renderer.currentFocusedRenderable!;
    expect(replacement).not.toBe(target);
    await host.dispose();
    expect(replacement.isDestroyed).toBe(true);
    expect(host.handlers.size).toBe(0);
    expect(host.hasCommands()).toBe(false);
    expect(host.renderer.keyInput.listenerCount("keypress")).toBe(listeners - 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
