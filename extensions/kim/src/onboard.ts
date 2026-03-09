import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";

const kimOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "kim",
  getStatus: async ({ cfg }) => {
    const configured = Boolean(cfg.channels?.kim?.appKey && cfg.channels?.kim?.secretKey);
    return {
      channel: "kim",
      configured,
      statusLines: [`Kim: ${configured ? "configured" : "needs appKey and secretKey"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({ cfg }) => {
    // 实现 Kim channel 的配置逻辑
    return { cfg };
  },
};

export { kimOnboardingAdapter };
