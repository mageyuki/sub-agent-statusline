import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";

// Each host loads only its own adapter. Importing this entry needs no host runtime.
// Host loaders supply their matching official arguments. Keep those inputs opaque
// in the public declaration and assert them only at dispatch to the typed adapter.
const plugin = {
  id: "subagent-statusline.tui",
  async tui(...args: [api: unknown, options: unknown, meta: unknown]): Promise<void> {
    const { default: v1 } = await import("./tui-v1.js");
    return v1.tui(...args as Parameters<TuiPlugin>);
  },
  async setup(context: unknown): Promise<void | (() => void | Promise<void>)> {
    const { default: v2 } = await import("./tui-v2.js");
    return v2.setup(context as Context);
  },
};

export default plugin;
