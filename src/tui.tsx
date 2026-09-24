import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";

// Each host loads only its own adapter. Importing this entry needs no host runtime.
const plugin = {
  id: "subagent-statusline.tui",
  async tui(...args: Parameters<TuiPlugin>) {
    const { default: v1 } = await import("./tui-v1.js");
    return v1.tui(...args);
  },
  async setup(context: Context) {
    const { default: v2 } = await import("./tui-v2.js");
    return v2.setup(context);
  },
};

export default plugin;
