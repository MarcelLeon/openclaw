import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "./types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getPairingAdapter, listPairingChannels } from "./pairing.js";

const emptyRegistry = createTestRegistry([]);

const createPlugin = (params: {
  id: string;
  withPairing?: boolean;
  idLabel?: string;
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.id,
    selectionLabel: params.id,
    docsPath: `/channels/${params.id}`,
    blurb: "test",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  ...(params.withPairing
    ? {
        pairing: {
          idLabel: params.idLabel ?? `${params.id}UserId`,
        },
      }
    : {}),
});

describe("pairing channel adapters", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("includes telegram fallback pairing channel when registry has no pairing adapters", () => {
    expect(listPairingChannels()).toEqual(["telegram"]);
    expect(getPairingAdapter("telegram")?.normalizeAllowEntry?.("tg:Alice")).toBe("@alice");
  });

  it("prefers plugin pairing adapter over fallback adapter for telegram", () => {
    const registry = createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createPlugin({
          id: "telegram",
          withPairing: true,
          idLabel: "telegramPluginUserId",
        }),
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry);

    expect(getPairingAdapter("telegram")?.idLabel).toBe("telegramPluginUserId");
  });

  it("returns a deduped union of plugin and fallback pairing channels", () => {
    const registry = createTestRegistry([
      {
        pluginId: "signal",
        plugin: createPlugin({ id: "signal", withPairing: true }),
        source: "test",
      },
      {
        pluginId: "telegram",
        plugin: createPlugin({ id: "telegram", withPairing: true }),
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry);

    const channels = listPairingChannels();
    expect(channels).toContain("signal");
    expect(channels).toContain("telegram");
    expect(new Set(channels).size).toBe(channels.length);
  });
});
