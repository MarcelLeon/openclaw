import type { OpenClawConfig, ReplyPayload } from "openclaw/plugin-sdk";
import type { OpenClawMessage, ResolvedKimAccount } from "./types.js";
import { KimApiClient } from "./client.js";
import { MessageConverter } from "./converter.js";
import { getKimRuntime } from "./runtime.js";

const CHANNEL_ID = "kim";

type InboundStatusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;

type InboundLogSink = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type InboundEventContext = {
  senderUsername?: string;
  senderUsernames?: string[];
  senderUserId?: string;
};

function normalizeUsernameCandidate(value: string | undefined | null): string | null {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }
  if (/^\d+$/.test(candidate)) {
    return null;
  }
  return candidate;
}

function resolveReplyUsernameCandidates(params: {
  message: OpenClawMessage;
  event: InboundEventContext;
}): string[] {
  const rawCandidates = [
    params.event.senderUsername,
    ...(params.event.senderUsernames ?? []),
    params.message.metadata?.senderUsername,
    params.message.author.name,
    params.event.senderUserId ? `user_${params.event.senderUserId}` : undefined,
    params.message.author.id ? `user_${params.message.author.id}` : undefined,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawCandidates) {
    const normalized = normalizeUsernameCandidate(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeAllowEntry(value: string): string {
  return value
    .replace(/^(kim|user):/i, "")
    .trim()
    .toLowerCase();
}

function isSenderAllowlisted(params: {
  senderId: string;
  senderName: string;
  allowFrom: string[];
}): boolean {
  const allow = params.allowFrom.map(normalizeAllowEntry).filter(Boolean);
  if (allow.length === 0) {
    return false;
  }
  if (allow.includes("*")) {
    return true;
  }
  const senderId = normalizeAllowEntry(params.senderId);
  const senderName = normalizeAllowEntry(params.senderName);
  return allow.some((entry) => entry === senderId || entry === senderName);
}

async function sendKimReply(params: {
  client: KimApiClient;
  account: ResolvedKimAccount;
  toUsernames: string[];
  payload: ReplyPayload;
  statusSink?: InboundStatusSink;
  log?: InboundLogSink;
}): Promise<void> {
  const text = params.payload.text?.trim() ?? "";
  const mediaUrls = (params.payload.mediaUrls ?? [])
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry));
  if (!mediaUrls.length && params.payload.mediaUrl?.trim()) {
    mediaUrls.push(params.payload.mediaUrl.trim());
  }

  if (!text && mediaUrls.length === 0) {
    return;
  }

  if (!params.toUsernames.length) {
    throw new Error("Kim reply target username is unavailable");
  }

  const sendToUsername = async (toUsername: string) => {
    const send = async (body: { text?: string; imageUrl?: string }) => {
      const mixCard = MessageConverter.toMixCard({
        text: body.text,
        imageUrl: body.imageUrl,
        appKey: params.account.appKey,
      });
      await params.client.sendMessageWithRetry({
        username: toUsername,
        mixCard,
      });
      params.statusSink?.({ lastOutboundAt: Date.now() });
    };

    if (mediaUrls.length > 0) {
      await send({ text: text || undefined, imageUrl: mediaUrls[0] });
      for (const mediaUrl of mediaUrls.slice(1)) {
        await send({ imageUrl: mediaUrl });
      }
      return;
    }

    await send({ text });
  };

  const isLookupFailure = (err: unknown): boolean => {
    const msg = String(err);
    return msg.includes("获取userid失败") || /failed to .*userid/i.test(msg);
  };

  let lastError: unknown = null;
  for (let index = 0; index < params.toUsernames.length; index += 1) {
    const username = params.toUsernames[index];
    try {
      await sendToUsername(username);
      if (index > 0) {
        params.log?.info?.(`kim: reply delivered via fallback username ${username}`);
      }
      return;
    } catch (err) {
      lastError = err;
      if (!isLookupFailure(err) || index === params.toUsernames.length - 1) {
        throw err;
      }
      params.log?.warn?.(
        `kim: reply username lookup failed for ${username}, trying next candidate`,
      );
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function resolveDmReplyUsernames(params: {
  account: ResolvedKimAccount;
  message: OpenClawMessage;
  event: InboundEventContext;
}): string[] {
  const candidates = resolveReplyUsernameCandidates(params);
  const mappedUsernames = params.account.config.replyUsernamesById ?? {};
  for (const userId of [params.event.senderUserId, params.message.author.id]) {
    const key = userId?.trim();
    if (!key) {
      continue;
    }
    const mapped = normalizeUsernameCandidate(mappedUsernames[key]);
    if (mapped && !candidates.includes(mapped)) {
      candidates.unshift(mapped);
    }
  }
  if (params.event.senderUserId) {
    const userById = normalizeUsernameCandidate(`user_${params.event.senderUserId}`);
    if (userById && !candidates.includes(userById)) {
      candidates.push(userById);
    }
  }
  return candidates;
}

async function enforceDmPolicy(params: {
  account: ResolvedKimAccount;
  message: OpenClawMessage;
  senderUsername: string | null;
  client: KimApiClient;
  log?: InboundLogSink;
}): Promise<{ allowed: boolean; commandAuthorized: boolean }> {
  const core = getKimRuntime();
  const dmPolicy = params.account.config.dm?.policy ?? "pairing";
  if (dmPolicy === "open") {
    return { allowed: true, commandAuthorized: true };
  }

  const configAllowFrom = (params.account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch((err) => {
    params.log?.warn?.(`kim: failed reading pairing allowFrom store: ${String(err)}`);
    return [] as string[];
  });
  const allowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
  const allowed = isSenderAllowlisted({
    senderId: params.message.author.id,
    senderName: params.message.author.name,
    allowFrom,
  });
  if (allowed) {
    return { allowed: true, commandAuthorized: true };
  }

  if (dmPolicy === "pairing") {
    const { code, created } = await core.channel.pairing.upsertPairingRequest({
      channel: CHANNEL_ID,
      id: params.message.author.id,
      meta: { name: params.message.author.name || undefined },
    });
    if (created && params.senderUsername) {
      await sendKimReply({
        client: params.client,
        account: params.account,
        toUsernames: [params.senderUsername],
        payload: {
          text: core.channel.pairing.buildPairingReply({
            channel: CHANNEL_ID,
            idLine: `Your Kim id: ${params.message.author.id}`,
            code,
          }),
        },
        log: params.log,
      }).catch((err) => {
        params.log?.error?.(`kim: pairing reply failed: ${String(err)}`);
      });
    } else if (created) {
      params.log?.warn?.("kim: pairing request created but sender username is unavailable");
    }
  }

  return { allowed: false, commandAuthorized: false };
}

function enforceGroupPolicy(params: {
  account: ResolvedKimAccount;
  message: OpenClawMessage;
  log?: InboundLogSink;
}): { allowed: boolean; commandAuthorized: boolean } {
  const groupPolicy = params.account.config.groupPolicy ?? "allowlist";
  if (groupPolicy === "open") {
    return { allowed: true, commandAuthorized: true };
  }

  const groupId = params.message.groupId?.trim();
  if (!groupId) {
    params.log?.warn?.("kim: dropping group message without groupId");
    return { allowed: false, commandAuthorized: false };
  }

  const allowedGroups = new Set(
    (params.account.config.allowedGroups ?? [])
      .map((entry) => String(entry))
      .map(normalizeAllowEntry)
      .filter(Boolean),
  );

  if (allowedGroups.has(normalizeAllowEntry(groupId))) {
    return { allowed: true, commandAuthorized: true };
  }

  params.log?.info?.(`kim: dropping group message from non-allowlisted group ${groupId}`);
  return { allowed: false, commandAuthorized: false };
}

export async function handleKimInboundMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedKimAccount;
  message: OpenClawMessage;
  event: InboundEventContext;
  statusSink?: InboundStatusSink;
  log?: InboundLogSink;
}): Promise<void> {
  const rawBody = params.message.text?.trim() ?? "";
  if (!rawBody) {
    params.log?.info?.("kim: inbound ignored because extracted body is empty");
    return;
  }
  if (rawBody === "[Interactive Event]") {
    params.log?.info?.("kim: inbound ignored placeholder interactive event");
    return;
  }

  const core = getKimRuntime();
  const senderUsernames = resolveDmReplyUsernames({
    account: params.account,
    message: params.message,
    event: params.event,
  });
  const senderUsername = senderUsernames[0] ?? null;

  const client = new KimApiClient({
    appKey: params.account.appKey,
    secretKey: params.account.secretKey,
    environment: params.account.environment,
  });

  let policy: { allowed: boolean; commandAuthorized: boolean };
  if (params.message.sessionType === "group") {
    policy = enforceGroupPolicy({
      account: params.account,
      message: params.message,
      log: params.log,
    });
  } else {
    policy = await enforceDmPolicy({
      account: params.account,
      message: params.message,
      senderUsername,
      client,
      log: params.log,
    });
  }

  if (!policy.allowed) {
    params.log?.info?.("kim: inbound blocked by channel policy");
    return;
  }

  const peerKind = params.message.sessionType === "group" ? "group" : "dm";
  const peerId =
    params.message.sessionType === "group"
      ? params.message.groupId || params.message.author.id
      : params.message.author.id;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: peerKind, id: peerId },
  });

  const storePath = core.channel.session.resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Kim",
    from: params.message.author.name || params.message.author.id,
    timestamp: params.message.timestamp.getTime(),
    previousTimestamp,
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(params.cfg),
    body: rawBody,
  });

  const from =
    params.message.sessionType === "group"
      ? `kim:group:${peerId}:user:${params.message.author.id}`
      : `kim:${params.message.author.id}`;
  const to =
    params.message.sessionType === "group"
      ? `kim:group:${peerId}`
      : `kim:${params.message.author.id}`;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: params.message.sessionType === "group" ? "group" : "direct",
    ConversationLabel: params.message.sessionType === "group" ? `group:${peerId}` : to,
    SenderName: params.message.author.name || undefined,
    SenderId: params.message.author.id,
    SenderUsername: senderUsername ?? undefined,
    GroupSubject: params.message.sessionType === "group" ? `group:${peerId}` : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: params.message.id,
    Timestamp: params.message.timestamp.getTime(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: to,
    CommandAuthorized: policy.commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      params.log?.error?.(`kim: failed updating session meta: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        if (!senderUsernames.length) {
          params.log?.warn?.(
            `kim: skip reply because sender username is unavailable (authorId=${params.message.author.id}, authorName=${params.message.author.name || "-"})`,
          );
          return;
        }
        await sendKimReply({
          client,
          account: params.account,
          toUsernames: senderUsernames,
          payload,
          statusSink: params.statusSink,
          log: params.log,
        });
      },
      onError: (err, info) => {
        params.log?.error?.(`kim ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      disableBlockStreaming: true,
    },
  });
}
