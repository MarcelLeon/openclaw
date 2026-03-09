import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { kimPlugin } from "./src/channel.js";
import { setKimRuntime } from "./src/runtime.js";

const plugin = {
  id: "kim",
  name: "Kim",
  description: "Kim Enterprise Messaging Platform channel plugin",
  version: "2026.2.1",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // 绑定 Runtime
    setKimRuntime(api.runtime);

    // 注册 Channel Provider
    api.registerChannel({ plugin: kimPlugin });
  },
};

export default plugin;
