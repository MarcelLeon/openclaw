import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  formatPairingApproveHint,
  normalizePluginHttpPath,
  registerPluginHttpRoute,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { KimWebhookEvent, ResolvedKimAccount } from "./types.js";
import { KimApiClient } from "./client.js";
import { MessageConverter } from "./converter.js";
import { handleKimInboundMessage } from "./inbound.js";
import { WebhookHandler } from "./webhook.js";

const DEFAULT_ACCOUNT_ID = "default";
const KIM_INBOUND_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

function isDuplicateKimInbound(params: {
  seen: Map<string, number>;
  eventType: string;
  dedupeId?: string | null;
  now?: number;
}): boolean {
  const dedupeId = params.dedupeId?.trim();
  if (!dedupeId) {
    return false;
  }
  const now = params.now ?? Date.now();
  const cutoff = now - KIM_INBOUND_DEDUPE_WINDOW_MS;
  for (const [key, ts] of params.seen) {
    if (ts < cutoff) {
      params.seen.delete(key);
    }
  }
  const dedupeKey = `${params.eventType}:${dedupeId}`;
  const previous = params.seen.get(dedupeKey);
  if (previous && now - previous <= KIM_INBOUND_DEDUPE_WINDOW_MS) {
    return true;
  }
  params.seen.set(dedupeKey, now);
  return false;
}

function resolveKimInboundDedupeId(event: KimWebhookEvent): string | null {
  const messageKey = event.info.messageKey?.trim();
  if (messageKey && !/^kim-\d+$/.test(messageKey)) {
    return `messageKey:${messageKey}`;
  }
  const uuid = event.uuid?.trim();
  if (uuid && !/^kim-\d+$/.test(uuid)) {
    return `uuid:${uuid}`;
  }
  const contentText = (event.info.mixCard?.blocks ?? [])
    .filter((block) => block.type === "content" && block.text?.content)
    .map((block) => block.text!.content.trim())
    .join("\n");
  const fingerprintSource = JSON.stringify({
    sessionType: event.info.sessionType,
    from: event.info.session?.from ?? null,
    to: event.info.session?.to ?? null,
    groupId: event.info.session?.groupId ?? null,
    actionValue: event.info.actionValue ?? null,
    contentText,
  });
  if (fingerprintSource === "{}") {
    return null;
  }
  const digest = createHash("sha1").update(fingerprintSource).digest("hex");
  return `fingerprint:${digest}`;
}

/**
 * Kim Channel Plugin
 * 实现 OpenClaw 的 ChannelPlugin 接口
 */
export const kimPlugin: ChannelPlugin<ResolvedKimAccount> = {
  id: "kim",

  meta: {
    displayName: "Kim",
    description: "Kim Enterprise Messaging Platform",
    docsPath: "/channels/kim",
    docsLabel: "kim",
    blurb: "Enterprise messaging platform with secure authentication and webhook integration.",
    systemImage: "building.columns",
    selectionDocsPrefix: "",
    selectionDocsOmitLabel: true,
    selectionExtras: ["https://openclaw.ai"],
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    polls: false,
    nativeCommands: false,
  },

  pairing: {
    idLabel: "kimUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(kim|user):/i, ""),
  },

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],

    resolveAccount: (cfg, accountId) => {
      const kimConfig = cfg.channels?.kim;
      if (!kimConfig) {
        throw new Error("Kim channel not configured");
      }

      return {
        accountId: accountId || DEFAULT_ACCOUNT_ID,
        appKey: kimConfig.appKey || "",
        secretKey: kimConfig.secretKey || "",
        environment: kimConfig.environment || "staging",
        callbackUrl: kimConfig.callbackUrl,
        callbackToken: kimConfig.callbackToken,
        enabled: kimConfig.enabled !== false,
        name: kimConfig.name,
        config: {
          dm: kimConfig.dm,
          groupPolicy: kimConfig.groupPolicy,
          allowedGroups: kimConfig.allowedGroups,
          replyUsernamesById: kimConfig.replyUsernamesById,
        },
      };
    },

    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    isConfigured: (account) => {
      return Boolean(account.appKey && account.secretKey);
    },

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appKey && account.secretKey),
      environment: account.environment,
    }),
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "pairing",
      allowFrom: account.config.dm?.allowFrom ?? [],
      allowFromPath: "channels.kim.dm.allowFrom",
      approveHint: formatPairingApproveHint("kim"),
      normalizeEntry: (raw) => raw.replace(/^(kim|user):/i, ""),
    }),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4096,

    sendText: async ({ to, text, accountId: _accountId, deps }) => {
      const username = extractUsername(to);
      const config = deps?.config || {};
      const kimConfig = config.channels?.kim;

      if (!kimConfig?.appKey || !kimConfig?.secretKey) {
        throw new Error("Kim credentials not configured");
      }

      const client = new KimApiClient({
        appKey: kimConfig.appKey,
        secretKey: kimConfig.secretKey,
        environment: kimConfig.environment || "staging",
      });

      const mixCard = MessageConverter.toMixCard({
        text,
        appKey: kimConfig.appKey,
      });

      const result = await client.sendMessageWithRetry({
        username,
        mixCard,
      });

      return {
        channel: "kim",
        messageId: result.messageKey || "",
        success: result.status === 0,
      };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId: _accountId, deps }) => {
      const username = extractUsername(to);
      const config = deps?.config || {};
      const kimConfig = config.channels?.kim;

      if (!kimConfig?.appKey || !kimConfig?.secretKey) {
        throw new Error("Kim credentials not configured");
      }

      const client = new KimApiClient({
        appKey: kimConfig.appKey,
        secretKey: kimConfig.secretKey,
        environment: kimConfig.environment || "staging",
      });

      const mixCard = MessageConverter.toMixCard({
        text,
        imageUrl: mediaUrl,
        appKey: kimConfig.appKey,
      });

      const result = await client.sendMessageWithRetry({
        username,
        mixCard,
      });

      return {
        channel: "kim",
        messageId: result.messageKey || "",
        success: result.status === 0,
      };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account } = ctx;
      const seenInboundMessageKeys = new Map<string, number>();
      const patchStatus = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => {
        ctx.setStatus({ ...ctx.getStatus(), ...patch });
      };

      // 验证配置
      if (!account.appKey || !account.secretKey) {
        throw new Error("Kim AppKey or SecretKey not configured");
      }

      // 创建 API 客户端
      const client = new KimApiClient({
        appKey: account.appKey,
        secretKey: account.secretKey,
        environment: account.environment,
      });

      // 验证凭证
      try {
        await client.verifyCredentials();
        ctx.log?.info(`[${account.accountId}] Kim bot authenticated successfully`);
      } catch (err) {
        ctx.log?.error(`[${account.accountId}] Kim bot authentication failed: ${err}`);
        throw err;
      }

      // 通过 OpenClaw 插件路由注册 webhook（不要依赖 runtime.expressApp）。
      const webhookPath = resolveWebhookPath(account.callbackUrl);
      const unregisterHttp = registerPluginHttpRoute({
        path: webhookPath,
        pluginId: "kim",
        accountId: account.accountId,
        log: (message) => ctx.log?.info?.(message),
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method === "GET") {
            respondJson(res, 200, {
              status: 0,
              message: "Kim webhook is running",
              data: {},
            });
            return;
          }

          if (req.method !== "POST") {
            respondJson(res, 405, { error: "Method Not Allowed" });
            return;
          }

          try {
            ctx.log?.info?.(`[${account.accountId}] Kim webhook POST received`);
            const rawBody = await readRequestBody(req);
            const callbackValidation = WebhookHandler.validateCallbackDetailed(
              req.headers,
              account.callbackToken,
              req.url,
              rawBody,
            );
            if (!callbackValidation.valid) {
              const candidates =
                callbackValidation.candidates.length > 0
                  ? callbackValidation.candidates
                      .map((entry) => {
                        const digest = createHash("sha1")
                          .update(entry.value)
                          .digest("hex")
                          .slice(0, 8);
                        return `${entry.source}(len=${entry.value.length},sha1=${digest})`;
                      })
                      .join("; ")
                  : "none";
              ctx.log?.warn?.(
                `[${account.accountId}] Kim webhook rejected: invalid callback token expectedLen=${
                  account.callbackToken?.length ?? 0
                } candidates=${candidates}`,
              );
              respondJson(res, 401, { error: "Unauthorized: Invalid token" });
              return;
            }

            const event = WebhookHandler.parseWebhookBody(rawBody);
            ctx.log?.info?.(
              `[${account.accountId}] Kim webhook parsed: type=${event.type} sessionType=${event.info.sessionType} messageKey=${event.info.messageKey} operatorUsername=${event.info.operator?.username ?? "-"} operatorUserId=${event.info.operator?.userId ?? "-"} forwardUsernames=${event.info.forward?.usernames?.join(",") ?? "-"}`,
            );
            const response = await WebhookHandler.handleEvent(
              event,
              async (message, webhookEvent) => {
                if (
                  isDuplicateKimInbound({
                    seen: seenInboundMessageKeys,
                    eventType: webhookEvent.type,
                    dedupeId: resolveKimInboundDedupeId(webhookEvent),
                  })
                ) {
                  ctx.log?.info?.(
                    `[${account.accountId}] kim: skip duplicate inbound event type=${webhookEvent.type} messageKey=${webhookEvent.info.messageKey}`,
                  );
                  return;
                }
                patchStatus({ lastInboundAt: Date.now() });
                void handleKimInboundMessage({
                  cfg: ctx.cfg,
                  account,
                  message,
                  event: {
                    senderUsername: webhookEvent.info.operator?.username,
                    senderUsernames: webhookEvent.info.forward?.usernames,
                    senderUserId: webhookEvent.info.operator?.userId
                      ? String(webhookEvent.info.operator.userId)
                      : undefined,
                  },
                  statusSink: patchStatus,
                  log: {
                    info: (msg) => ctx.log?.info?.(`[${account.accountId}] ${msg}`),
                    warn: (msg) => ctx.log?.warn?.(`[${account.accountId}] ${msg}`),
                    error: (msg) => ctx.log?.error?.(`[${account.accountId}] ${msg}`),
                  },
                }).catch((err) => {
                  ctx.log?.error?.(
                    `[${account.accountId}] Kim inbound handling failed: ${String(err)}`,
                  );
                });
              },
            );
            respondJson(res, 200, response);
          } catch (error) {
            ctx.log?.error?.(
              `[${account.accountId}] Kim webhook handling failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            respondJson(res, 500, {
              status: 1,
              message: error instanceof Error ? error.message : "Internal server error",
              data: {},
            });
          }
        },
      });
      ctx.log?.info(`[${account.accountId}] Kim webhook route ready: ${webhookPath}`);

      // 注册 Webhook 回调地址（可选）。
      if (account.callbackUrl) {
        try {
          await client.registerCallback({
            callBackUrl: account.callbackUrl,
            callBackToken: account.callbackToken,
          });
          ctx.log?.info(`[${account.accountId}] Kim webhook registered: ${account.callbackUrl}`);
        } catch (err) {
          ctx.log?.warn(`[${account.accountId}] Failed to register webhook: ${err}`);
        }
      } else {
        ctx.log?.warn(`[${account.accountId}] No callback URL configured, webhook disabled`);
      }

      // 保持运行（等待 abort signal）
      return new Promise((resolve) => {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            unregisterHttp();
            ctx.log?.info(`[${account.accountId}] Kim gateway stopped`);
            resolve();
          },
          { once: true },
        );
      });
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.appKey || !account.secretKey) {
        return {
          ok: false,
          error: "Missing credentials",
        };
      }

      const client = new KimApiClient({
        appKey: account.appKey,
        secretKey: account.secretKey,
        environment: account.environment,
      });

      try {
        const info = await client.getBotInfo(timeoutMs);
        return {
          ok: true,
          botInfo: info,
        };
      } catch (err) {
        return {
          ok: false,
          error: String(err),
        };
      }
    },
  },
};

/**
 * 从目标地址中提取 username
 * 支持格式：user:username, kim:username, username
 */
function extractUsername(to: string): string {
  return to.replace(/^(kim|user):/i, "");
}

function resolveWebhookPath(callbackUrl?: string): string {
  const fallback = "/webhook/kim";
  if (!callbackUrl?.trim()) {
    return fallback;
  }
  try {
    const url = new URL(callbackUrl);
    return normalizePluginHttpPath(url.pathname, fallback) ?? fallback;
  } catch {
    return normalizePluginHttpPath(callbackUrl, fallback) ?? fallback;
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
