import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("./tui-v1.js");
  vi.doUnmock("./tui-v2.js");
});

it("imports the public entry without evaluating either host adapter", async () => {
  vi.doMock("./tui-v1.js", () => { throw new Error("V1 runtime unavailable"); });
  vi.doMock("./tui-v2.js", () => { throw new Error("V2 runtime unavailable"); });
  const entry = import("./tui.js");
  await expect(entry).resolves.toMatchObject({ default: {
    id: "subagent-statusline.tui", tui: expect.any(Function), setup: expect.any(Function),
  } });
});

it("loads only V1 on tui and forwards all three arguments unchanged", async () => {
  const tui = vi.fn<TuiPlugin>(async () => {});
  const evaluate = vi.fn(() => ({ default: { id: "subagent-statusline.tui", tui } }));
  vi.doMock("./tui-v1.js", evaluate);
  vi.doMock("./tui-v2.js", () => { throw new Error("wrong host"); });
  const { default: bridge } = await import("./tui.js");
  expect(evaluate).not.toHaveBeenCalled();
  const api = {} as Parameters<TuiPlugin>[0];
  const options = { enabled: true };
  const meta = {} as Parameters<TuiPlugin>[2];
  await bridge.tui(api, options, meta);
  expect(evaluate).toHaveBeenCalledOnce();
  expect(tui.mock.calls).toHaveLength(1);
  expect(tui.mock.calls[0][0]).toBe(api);
  expect(tui.mock.calls[0][1]).toBe(options);
  expect(tui.mock.calls[0][2]).toBe(meta);
});

it("loads only V2 on setup and returns the identical cleanup", async () => {
  const cleanup = vi.fn(async () => {});
  const setup = vi.fn(async (_context: Context) => cleanup);
  const evaluate = vi.fn(() => ({ default: { id: "subagent-statusline.tui", setup } }));
  vi.doMock("./tui-v1.js", () => { throw new Error("wrong host"); });
  vi.doMock("./tui-v2.js", evaluate);
  const { default: bridge } = await import("./tui.js");
  expect(evaluate).not.toHaveBeenCalled();
  const context = {} as Context;
  expect(await bridge.setup(context)).toBe(cleanup);
  expect(evaluate).toHaveBeenCalledOnce();
  expect(setup.mock.calls).toHaveLength(1);
  expect(setup.mock.calls[0][0]).toBe(context);
  expect(cleanup).not.toHaveBeenCalled();
});

it("propagates V2 setup rejection without trying V1", async () => {
  const failure = new Error("V2 setup failed");
  vi.doMock("./tui-v1.js", () => { throw new Error("wrong host"); });
  vi.doMock("./tui-v2.js", () => ({ default: { setup: async () => { throw failure; } } }));
  const { default: bridge } = await import("./tui.js");
  await expect(bridge.setup({} as Context)).rejects.toBe(failure);
});

it("propagates V1 initialization rejection without trying V2", async () => {
  const failure = new Error("V1 setup failed");
  vi.doMock("./tui-v1.js", () => ({ default: { tui: async () => { throw failure; } } }));
  vi.doMock("./tui-v2.js", () => { throw new Error("wrong host"); });
  const { default: bridge } = await import("./tui.js");
  await expect(bridge.tui({} as Parameters<TuiPlugin>[0], undefined,
    {} as Parameters<TuiPlugin>[2])).rejects.toBe(failure);
});
