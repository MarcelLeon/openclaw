#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="cn-easy"
GATEWAY_PORT_INPUT=""
BRIDGE_PORT_INPUT=""
SKIP_START=0
MOONSHOT_API_KEY="${MOONSHOT_API_KEY:-}"
QQ_API_URL="${QQ_API_URL:-}"
QQ_ACCESS_TOKEN="${QQ_ACCESS_TOKEN:-}"
DINGTALK_WEBHOOK_URL="${DINGTALK_WEBHOOK_URL:-}"
DINGTALK_SECRET="${DINGTALK_SECRET:-}"
FEISHU_WEBHOOK_URL="${FEISHU_WEBHOOK_URL:-}"
FEISHU_SECRET="${FEISHU_SECRET:-}"
QQ_PLUGIN_SPEC="${QQ_PLUGIN_SPEC:-}"
DINGTALK_PLUGIN_SPEC="${DINGTALK_PLUGIN_SPEC:-}"
FEISHU_PLUGIN_SPEC="${FEISHU_PLUGIN_SPEC:-}"
PLUGIN_SOURCES_FILE="${PLUGIN_SOURCES_FILE:-${SCRIPT_DIR}/install-cn-plugin-sources.env}"
OPENCLAW_INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.ai/install.sh}"
ONLY_CHANNEL="all"

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
OpenClaw CN one-click installer (macOS Intel + Apple Silicon)

Usage:
  bash scripts/install-cn-oneclick.sh [options]

Options:
  --profile <name>                 Isolated profile name (default: cn-easy)
  --moonshot-api-key <key>         Moonshot API key (required)
  --qq-api-url <url>               QQ OneBot API base URL (optional)
  --qq-access-token <token>        QQ OneBot access token (optional)
  --qq-plugin-spec <spec>          Install QQ plugin from GitHub/npm spec (optional)
  --dingtalk-webhook-url <url>     DingTalk robot webhook URL (optional)
  --dingtalk-secret <secret>       DingTalk robot signing secret (optional)
  --dingtalk-plugin-spec <spec>    Install DingTalk plugin from GitHub/npm spec (optional)
  --feishu-webhook-url <url>       Feishu bot webhook URL (optional)
  --feishu-secret <secret>         Feishu bot signing secret (optional)
  --feishu-plugin-spec <spec>      Install Feishu plugin from GitHub/npm spec (optional)
  --only-channel <name>            qq|dingtalk|feishu|all (default: all)
  --gateway-port <port>            Gateway port (default: first free >=18790)
  --bridge-port <port>             Bridge port (default: first free >=18890)
  --skip-start                     Do not auto-start gateway + bridge
  -h, --help                       Show this help
EOF
}

need_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing required command: $cmd"
}

squote() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\"\'\"\'}"
}

ensure_line_once() {
  local file="$1"
  local line="$2"
  touch "$file"
  if ! rg -n --fixed-strings -- "$line" "$file" >/dev/null 2>&1; then
    printf '%s\n' "$line" >>"$file"
  fi
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return
  fi
  local raw
  raw="$(node -v 2>/dev/null || true)"
  raw="${raw#v}"
  echo "${raw%%.*}"
}

ensure_node22() {
  local major
  major="$(node_major_version)"
  if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
    return
  fi

  log "Node.js 22+ not found. Installing with nvm..."
  need_cmd curl
  need_cmd bash

  export NVM_DIR="${HOME}/.nvm"
  if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
    bash -lc "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  fi

  # shellcheck disable=SC1090
  source "${NVM_DIR}/nvm.sh"
  nvm install 22 >/dev/null
  nvm alias default 22 >/dev/null
  nvm use 22 >/dev/null

  ensure_line_once "${HOME}/.zshrc" 'export NVM_DIR="$HOME/.nvm"'
  ensure_line_once "${HOME}/.zshrc" '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'

  major="$(node_major_version)"
  if [[ ! "$major" =~ ^[0-9]+$ ]] || (( major < 22 )); then
    fail "Node.js 22+ install failed."
  fi
}

refresh_path() {
  export PATH="${HOME}/.local/bin:${HOME}/.npm/bin:${HOME}/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:${PATH}"
}

ensure_openclaw_cli() {
 if command -v openclaw >/dev/null 2>&1; then
    return
  fi
  log "OpenClaw CLI not found. Installing from official installer..."
  need_cmd curl
  curl -fsSL "$OPENCLAW_INSTALL_URL" | bash
  refresh_path
  if ! command -v openclaw >/dev/null 2>&1; then
    fail "openclaw command still not found after install."
  fi
}

is_port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

pick_free_port() {
  local start="$1"
  local p="$start"
  while is_port_in_use "$p"; do
    p=$((p + 1))
    if (( p > start + 200 )); then
      fail "No free port found starting from ${start}"
    fi
  done
  echo "$p"
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi
  printf '%s' "token-$(date +%s)-$RANDOM-$RANDOM"
}

channel_enabled() {
  local name="$1"
  if [[ "$ONLY_CHANNEL" == "all" ]]; then
    return 0
  fi
  [[ "$ONLY_CHANNEL" == "$name" ]]
}

load_plugin_sources_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    return
  fi
  # shellcheck disable=SC1090
  source "$path"
}

profile_state_dir() {
  local profile="$1"
  if [[ "$profile" == "default" ]]; then
    printf '%s/.openclaw' "$HOME"
  else
    printf '%s/.openclaw-%s' "$HOME" "$profile"
  fi
}

write_qq_plugin() {
  local ext_dir="$1"
  mkdir -p "$ext_dir/qq"
  cat >"$ext_dir/qq/openclaw.plugin.json" <<'EOF'
{
  "id": "qq",
  "channels": ["qq"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
EOF
  cat >"$ext_dir/qq/index.mjs" <<'EOF'
const DEFAULT_ACCOUNT_ID = "default";

function channelSection(cfg) {
  const section = cfg?.channels?.qq;
  return section && typeof section === "object" ? section : {};
}

function resolveAccount(cfg) {
  const section = channelSection(cfg);
  const apiBaseUrl = typeof section.apiBaseUrl === "string" ? section.apiBaseUrl.trim() : "";
  const accessToken = typeof section.accessToken === "string" ? section.accessToken.trim() : "";
  const defaultTargetType = section.defaultTargetType === "group" ? "group" : "private";
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: section.enabled !== false,
    apiBaseUrl,
    accessToken,
    defaultTargetType,
  };
}

function parseTarget(to, defaultTargetType) {
  const raw = String(to ?? "").trim();
  if (!raw) {
    return { ok: false, error: "qq target is required (example: user:123456 or group:123456)" };
  }
  if (/^(group|g):/i.test(raw)) {
    return { ok: true, messageType: "group", id: raw.replace(/^(group|g):/i, "").trim() };
  }
  if (/^(user|u):/i.test(raw)) {
    return { ok: true, messageType: "private", id: raw.replace(/^(user|u):/i, "").trim() };
  }
  return { ok: true, messageType: defaultTargetType === "group" ? "group" : "private", id: raw };
}

function parseNumericId(raw) {
  const value = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

async function sendMessageQQ(params) {
  const account = resolveAccount(params.cfg);
  if (!account.apiBaseUrl) {
    throw new Error("QQ apiBaseUrl is not configured");
  }
  const target = parseTarget(params.to, account.defaultTargetType);
  if (!target.ok) {
    throw new Error(target.error);
  }
  const parsedId = parseNumericId(target.id);
  if (parsedId == null) {
    throw new Error(`Invalid QQ target id: ${target.id}`);
  }

  const apiBase = account.apiBaseUrl.replace(/\/+$/, "");
  const endpoint = `${apiBase}/send_msg`;
  const body = {
    message_type: target.messageType,
    message: params.text,
    auto_escape: false,
    ...(target.messageType === "group" ? { group_id: parsedId } : { user_id: parsedId }),
  };
  const headers = { "Content-Type": "application/json" };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.status === "failed") {
    const detail =
      payload?.wording ||
      payload?.msg ||
      payload?.message ||
      `HTTP ${response.status}`;
    throw new Error(`QQ send failed: ${detail}`);
  }
  return String(payload?.data?.message_id ?? "");
}

const qqChannelPlugin = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ",
    selectionLabel: "QQ (OneBot)",
    docsPath: "/channels/qq",
    docsLabel: "qq",
    blurb: "QQ via OneBot HTTP API.",
    aliases: ["onebot"],
    order: 72,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        qq: {
          ...cfg.channels?.qq,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg };
      const channels = { ...(cfg.channels ?? {}) };
      delete channels.qq;
      if (Object.keys(channels).length > 0) {
        next.channels = channels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (account) => Boolean(account.apiBaseUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.apiBaseUrl),
      baseUrl: account.apiBaseUrl || undefined,
    }),
    resolveAllowFrom: () => [],
    formatAllowFrom: () => [],
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    validateInput: ({ cfg, input }) => {
      const existingUrl =
        typeof cfg?.channels?.qq?.apiBaseUrl === "string" ? cfg.channels.qq.apiBaseUrl.trim() : "";
      const nextUrl = typeof input.httpUrl === "string" ? input.httpUrl.trim() : "";
      if (!nextUrl && !existingUrl) {
        return "QQ requires --http-url (OneBot API base URL).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        qq: {
          ...cfg.channels?.qq,
          enabled: true,
          ...(typeof input.httpUrl === "string" && input.httpUrl.trim()
            ? { apiBaseUrl: input.httpUrl.trim() }
            : {}),
          ...(typeof input.token === "string" && input.token.trim()
            ? { accessToken: input.token.trim() }
            : {}),
        },
      },
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = String(raw ?? "").trim();
      return trimmed || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = String(raw ?? "").trim();
        return /^(group|g|user|u):\d+$/i.test(trimmed) || /^\d+$/.test(trimmed);
      },
      hint: "user:<id> | group:<id>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 1500,
    sendText: async ({ to, text, cfg }) => {
      try {
        const messageId = await sendMessageQQ({ to, text, cfg });
        return { channel: "qq", ok: true, messageId };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { channel: "qq", ok: false, messageId: "", error: err };
      }
    },
  },
};

export default {
  id: "qq",
  name: "QQ (OneBot)",
  description: "QQ channel plugin for OneBot HTTP API",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api) {
    api.registerChannel({ plugin: qqChannelPlugin });
  },
};
EOF
}

write_dingtalk_plugin() {
  local ext_dir="$1"
  mkdir -p "$ext_dir/dingtalk"
  cat >"$ext_dir/dingtalk/openclaw.plugin.json" <<'EOF'
{
  "id": "dingtalk",
  "channels": ["dingtalk"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
EOF
  cat >"$ext_dir/dingtalk/index.mjs" <<'EOF'
import { createHmac } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "default";

function channelSection(cfg) {
  const section = cfg?.channels?.dingtalk;
  return section && typeof section === "object" ? section : {};
}

function normalizeTargetKey(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function resolveAccount(cfg) {
  const section = channelSection(cfg);
  const webhookUrl = typeof section.webhookUrl === "string" ? section.webhookUrl.trim() : "";
  const secret = typeof section.secret === "string" ? section.secret.trim() : "";
  const targets =
    section.targets && typeof section.targets === "object" ? section.targets : undefined;
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: section.enabled !== false,
    webhookUrl,
    secret,
    targets,
  };
}

function resolveTargetWebhook(account, to) {
  const key = normalizeTargetKey(to);
  if (key && account.targets && typeof account.targets[key] === "object") {
    const entry = account.targets[key];
    const webhookUrl =
      typeof entry.webhookUrl === "string" ? entry.webhookUrl.trim() : account.webhookUrl;
    const secret = typeof entry.secret === "string" ? entry.secret.trim() : account.secret;
    if (webhookUrl) {
      return { webhookUrl, secret };
    }
  }
  if (account.webhookUrl) {
    return { webhookUrl: account.webhookUrl, secret: account.secret };
  }
  return null;
}

function withSign(webhookUrl, secret) {
  if (!secret) {
    return webhookUrl;
  }
  const timestamp = Date.now().toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = encodeURIComponent(
    createHmac("sha256", secret).update(stringToSign).digest("base64"),
  );
  const url = new URL(webhookUrl);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("sign", sign);
  return url.toString();
}

async function sendMessageDingTalk(params) {
  const account = resolveAccount(params.cfg);
  const target = resolveTargetWebhook(account, params.to);
  if (!target) {
    throw new Error("DingTalk webhookUrl is not configured");
  }
  const url = withSign(target.webhookUrl, target.secret);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content: params.text },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.errcode ?? 0) !== 0) {
    const detail =
      payload?.errmsg || payload?.message || payload?.msg || `HTTP ${response.status}`;
    throw new Error(`DingTalk send failed: ${detail}`);
  }
  return String(payload?.request_id ?? payload?.task_id ?? Date.now());
}

const dingtalkChannelPlugin = {
  id: "dingtalk",
  meta: {
    id: "dingtalk",
    label: "DingTalk",
    selectionLabel: "DingTalk (Robot Webhook)",
    docsPath: "/channels/dingtalk",
    docsLabel: "dingtalk",
    blurb: "DingTalk bot webhook channel.",
    aliases: ["ding"],
    order: 71,
  },
  capabilities: {
    chatTypes: ["group"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        dingtalk: {
          ...cfg.channels?.dingtalk,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg };
      const channels = { ...(cfg.channels ?? {}) };
      delete channels.dingtalk;
      if (Object.keys(channels).length > 0) {
        next.channels = channels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (account) => Boolean(account.webhookUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.webhookUrl),
      webhookUrl: account.webhookUrl || undefined,
    }),
    resolveAllowFrom: () => [],
    formatAllowFrom: () => [],
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    validateInput: ({ cfg, input }) => {
      const existingUrl =
        typeof cfg?.channels?.dingtalk?.webhookUrl === "string"
          ? cfg.channels.dingtalk.webhookUrl.trim()
          : "";
      const nextUrl = typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : "";
      if (!nextUrl && !existingUrl) {
        return "DingTalk requires --webhook-url.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        dingtalk: {
          ...cfg.channels?.dingtalk,
          enabled: true,
          ...(typeof input.webhookUrl === "string" && input.webhookUrl.trim()
            ? { webhookUrl: input.webhookUrl.trim() }
            : {}),
          ...(typeof input.token === "string" && input.token.trim()
            ? { secret: input.token.trim() }
            : {}),
        },
      },
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = String(raw ?? "").trim();
      return trimmed || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = String(raw ?? "").trim();
        return trimmed.length > 0;
      },
      hint: "<conversationId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 1200,
    sendText: async ({ to, text, cfg }) => {
      try {
        const messageId = await sendMessageDingTalk({ to, text, cfg });
        return { channel: "dingtalk", ok: true, messageId };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { channel: "dingtalk", ok: false, messageId: "", error: err };
      }
    },
  },
};

export default {
  id: "dingtalk",
  name: "DingTalk (Webhook)",
  description: "DingTalk channel plugin for robot webhooks",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api) {
    api.registerChannel({ plugin: dingtalkChannelPlugin });
  },
};
EOF
}

write_feishu_plugin() {
  local ext_dir="$1"
  mkdir -p "$ext_dir/feishu"
  cat >"$ext_dir/feishu/openclaw.plugin.json" <<'EOF'
{
  "id": "feishu",
  "channels": ["feishu"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
EOF
  cat >"$ext_dir/feishu/index.mjs" <<'EOF'
import { createHmac } from "node:crypto";

const DEFAULT_ACCOUNT_ID = "default";

function channelSection(cfg) {
  const section = cfg?.channels?.feishu;
  return section && typeof section === "object" ? section : {};
}

function normalizeTargetKey(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function resolveAccount(cfg) {
  const section = channelSection(cfg);
  const webhookUrl = typeof section.webhookUrl === "string" ? section.webhookUrl.trim() : "";
  const secret = typeof section.secret === "string" ? section.secret.trim() : "";
  const targets =
    section.targets && typeof section.targets === "object" ? section.targets : undefined;
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: section.enabled !== false,
    webhookUrl,
    secret,
    targets,
  };
}

function resolveTargetWebhook(account, to) {
  const key = normalizeTargetKey(to);
  if (key && account.targets && typeof account.targets[key] === "object") {
    const entry = account.targets[key];
    const webhookUrl =
      typeof entry.webhookUrl === "string" ? entry.webhookUrl.trim() : account.webhookUrl;
    const secret = typeof entry.secret === "string" ? entry.secret.trim() : account.secret;
    if (webhookUrl) {
      return { webhookUrl, secret };
    }
  }
  if (account.webhookUrl) {
    return { webhookUrl: account.webhookUrl, secret: account.secret };
  }
  return null;
}

function buildSignedBody(text, secret) {
  if (!secret) {
    return {
      msg_type: "text",
      content: { text },
    };
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = createHmac("sha256", `${timestamp}\n${secret}`).digest("base64");
  return {
    timestamp,
    sign,
    msg_type: "text",
    content: { text },
  };
}

async function sendMessageFeishu(params) {
  const account = resolveAccount(params.cfg);
  const target = resolveTargetWebhook(account, params.to);
  if (!target) {
    throw new Error("Feishu webhookUrl is not configured");
  }
  const body = buildSignedBody(params.text, target.secret);
  const response = await fetch(target.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.code ?? 0) !== 0) {
    const detail =
      payload?.msg || payload?.message || payload?.errmsg || `HTTP ${response.status}`;
    throw new Error(`Feishu send failed: ${detail}`);
  }
  return String(payload?.data?.task_id ?? Date.now());
}

const feishuChannelPlugin = {
  id: "feishu",
  meta: {
    id: "feishu",
    label: "Feishu",
    selectionLabel: "Feishu (Bot Webhook)",
    docsPath: "/channels/feishu",
    docsLabel: "feishu",
    blurb: "Feishu group bot webhook channel.",
    aliases: ["lark"],
    order: 70,
  },
  capabilities: {
    chatTypes: ["group"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: {
          ...cfg.channels?.feishu,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg };
      const channels = { ...(cfg.channels ?? {}) };
      delete channels.feishu;
      if (Object.keys(channels).length > 0) {
        next.channels = channels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (account) => Boolean(account.webhookUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.webhookUrl),
      webhookUrl: account.webhookUrl || undefined,
    }),
    resolveAllowFrom: () => [],
    formatAllowFrom: () => [],
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    validateInput: ({ cfg, input }) => {
      const existingUrl =
        typeof cfg?.channels?.feishu?.webhookUrl === "string"
          ? cfg.channels.feishu.webhookUrl.trim()
          : "";
      const nextUrl = typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : "";
      if (!nextUrl && !existingUrl) {
        return "Feishu requires --webhook-url.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: {
          ...cfg.channels?.feishu,
          enabled: true,
          ...(typeof input.webhookUrl === "string" && input.webhookUrl.trim()
            ? { webhookUrl: input.webhookUrl.trim() }
            : {}),
          ...(typeof input.token === "string" && input.token.trim()
            ? { secret: input.token.trim() }
            : {}),
        },
      },
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = String(raw ?? "").trim();
      return trimmed || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = String(raw ?? "").trim();
        return trimmed.length > 0;
      },
      hint: "<chatId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 1200,
    sendText: async ({ to, text, cfg }) => {
      try {
        const messageId = await sendMessageFeishu({ to, text, cfg });
        return { channel: "feishu", ok: true, messageId };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { channel: "feishu", ok: false, messageId: "", error: err };
      }
    },
  },
};

export default {
  id: "feishu",
  name: "Feishu (Webhook)",
  description: "Feishu channel plugin for bot webhooks",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api) {
    api.registerChannel({ plugin: feishuChannelPlugin });
  },
};
EOF
}

write_bridge_script() {
  local bridge_dir="$1"
  mkdir -p "$bridge_dir"
  cat >"$bridge_dir/openclaw-cn-bridge.mjs" <<'EOF'
import http from "node:http";

const bridgePort = Number.parseInt(process.env.OPENCLAW_CN_BRIDGE_PORT ?? "18890", 10);
const hookUrl = process.env.OPENCLAW_CN_HOOK_URL ?? "http://127.0.0.1:18790/hooks/agent";
const hookToken = process.env.OPENCLAW_CN_HOOK_TOKEN ?? "";

if (!hookToken) {
  console.error("[bridge] OPENCLAW_CN_HOOK_TOKEN is empty.");
  process.exit(1);
}

function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function qqTargetFromEvent(event) {
  const messageType = String(event?.message_type ?? "").toLowerCase();
  if (messageType === "group") {
    return `group:${String(event?.group_id ?? "").trim()}`;
  }
  return `user:${String(event?.user_id ?? "").trim()}`;
}

function qqSessionFromEvent(event) {
  const messageType = String(event?.message_type ?? "").toLowerCase();
  if (messageType === "group") {
    return `qq:group:${String(event?.group_id ?? "").trim()}`;
  }
  return `qq:user:${String(event?.user_id ?? "").trim()}`;
}

function extractQQText(event) {
  const text = String(event?.raw_message ?? event?.message ?? "").trim();
  return text;
}

function extractDingTalkText(payload) {
  const first =
    payload?.text?.content ??
    payload?.conversationData?.text ??
    payload?.msg?.content ??
    payload?.message ??
    "";
  return String(first).trim();
}

function dingtalkTarget(payload) {
  const value =
    payload?.conversationId ??
    payload?.conversation?.conversationId ??
    payload?.chatbotCorpId ??
    payload?.senderStaffId ??
    "default";
  return String(value).trim() || "default";
}

function dingtalkSession(payload) {
  const value =
    payload?.conversationId ??
    payload?.conversation?.conversationId ??
    payload?.senderStaffId ??
    `staff:${String(payload?.senderNick ?? "unknown").trim()}`;
  return `dingtalk:${String(value).trim() || "default"}`;
}

function extractFeishuText(payload) {
  const rawContent =
    payload?.event?.message?.content ??
    payload?.event?.content ??
    payload?.content ??
    "";
  const textFromJson = (() => {
    if (typeof rawContent !== "string") {
      return "";
    }
    const trimmed = rawContent.trim();
    if (!trimmed) {
      return "";
    }
    try {
      const parsed = JSON.parse(trimmed);
      return String(parsed?.text ?? "").trim();
    } catch {
      return trimmed;
    }
  })();
  if (textFromJson) {
    return textFromJson;
  }
  return String(payload?.text ?? "").trim();
}

function feishuTarget(payload) {
  const value =
    payload?.event?.message?.chat_id ??
    payload?.event?.chat_id ??
    payload?.chat_id ??
    "default";
  return String(value).trim() || "default";
}

function feishuSession(payload) {
  const value =
    payload?.event?.message?.chat_id ??
    payload?.event?.open_id ??
    payload?.event?.sender?.sender_id?.open_id ??
    payload?.open_id ??
    "default";
  return `feishu:${String(value).trim() || "default"}`;
}

async function dispatchHook({ channel, to, message, sessionKey }) {
  const body = {
    name: `${channel}-bridge`,
    wakeMode: "now",
    deliver: true,
    channel,
    to,
    message,
    sessionKey,
  };
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hookToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`hook call failed: HTTP ${response.status} ${detail}`);
  }
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/qq/onebot") {
    try {
      const payload = await readJson(req);
      if (String(payload?.post_type ?? "") !== "message") {
        json(res, 200, { ok: true, ignored: "not-message-event" });
        return;
      }
      if (Number(payload?.self_id ?? 0) > 0 && payload?.user_id === payload?.self_id) {
        json(res, 200, { ok: true, ignored: "self-message" });
        return;
      }
      const text = extractQQText(payload);
      if (!text) {
        json(res, 200, { ok: true, ignored: "empty-message" });
        return;
      }
      const to = qqTargetFromEvent(payload);
      const sessionKey = qqSessionFromEvent(payload);
      await dispatchHook({ channel: "qq", to, message: text, sessionKey });
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/dingtalk/inbound") {
    try {
      const payload = await readJson(req);
      const text = extractDingTalkText(payload);
      if (!text) {
        json(res, 200, { ok: true, ignored: "empty-message" });
        return;
      }
      const to = dingtalkTarget(payload);
      const sessionKey = dingtalkSession(payload);
      await dispatchHook({ channel: "dingtalk", to, message: text, sessionKey });
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/feishu/inbound") {
    try {
      const payload = await readJson(req);
      if (typeof payload?.challenge === "string" && payload.challenge.trim()) {
        json(res, 200, { challenge: payload.challenge });
        return;
      }
      const text = extractFeishuText(payload);
      if (!text) {
        json(res, 200, { ok: true, ignored: "empty-message" });
        return;
      }
      const to = feishuTarget(payload);
      const sessionKey = feishuSession(payload);
      await dispatchHook({ channel: "feishu", to, message: text, sessionKey });
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  json(res, 404, { ok: false, error: "not-found" });
});

server.listen(bridgePort, "127.0.0.1", () => {
  console.log(`[bridge] listening on http://127.0.0.1:${bridgePort}`);
  console.log(`[bridge] hook endpoint: ${hookUrl}`);
});
EOF
}

write_runtime_scripts() {
  local runtime_dir="$1"
  local state_dir="$2"
  local profile="$3"
  local gateway_port="$4"
  local bridge_port="$5"
  local hook_token="$6"
  local gateway_token="$7"

  mkdir -p "$runtime_dir/logs"
  mkdir -p "$runtime_dir/pids"

  cat >"$runtime_dir/.env.sh" <<EOF
OPENCLAW_CN_PROFILE=$(squote "$profile")
OPENCLAW_CN_GATEWAY_PORT=$(squote "$gateway_port")
OPENCLAW_CN_BRIDGE_PORT=$(squote "$bridge_port")
OPENCLAW_CN_GATEWAY_TOKEN=$(squote "$gateway_token")
OPENCLAW_CN_HOOK_TOKEN=$(squote "$hook_token")
OPENCLAW_CN_HOOK_URL=$(squote "http://127.0.0.1:${gateway_port}/hooks/agent")
EOF

  cat >"$runtime_dir/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${RUNTIME_DIR}/.env.sh"

GATEWAY_LOG="${RUNTIME_DIR}/logs/gateway.log"
BRIDGE_LOG="${RUNTIME_DIR}/logs/bridge.log"
GATEWAY_PID_FILE="${RUNTIME_DIR}/pids/gateway.pid"
BRIDGE_PID_FILE="${RUNTIME_DIR}/pids/bridge.pid"
BRIDGE_SCRIPT="${RUNTIME_DIR}/bridge/openclaw-cn-bridge.mjs"

is_port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

if is_port_in_use "$OPENCLAW_CN_GATEWAY_PORT"; then
  echo "Gateway port ${OPENCLAW_CN_GATEWAY_PORT} is already in use, skip gateway start."
else
  nohup openclaw --profile "$OPENCLAW_CN_PROFILE" gateway run \
    --bind loopback \
    --port "$OPENCLAW_CN_GATEWAY_PORT" \
    --force >"$GATEWAY_LOG" 2>&1 &
  echo $! >"$GATEWAY_PID_FILE"
  echo "Gateway started (pid $(cat "$GATEWAY_PID_FILE"))."
fi

if is_port_in_use "$OPENCLAW_CN_BRIDGE_PORT"; then
  echo "Bridge port ${OPENCLAW_CN_BRIDGE_PORT} is already in use, skip bridge start."
else
  OPENCLAW_CN_BRIDGE_PORT="$OPENCLAW_CN_BRIDGE_PORT" \
  OPENCLAW_CN_HOOK_TOKEN="$OPENCLAW_CN_HOOK_TOKEN" \
  OPENCLAW_CN_HOOK_URL="$OPENCLAW_CN_HOOK_URL" \
  nohup node "$BRIDGE_SCRIPT" >"$BRIDGE_LOG" 2>&1 &
  echo $! >"$BRIDGE_PID_FILE"
  echo "Bridge started (pid $(cat "$BRIDGE_PID_FILE"))."
fi

echo "Logs:"
echo "  Gateway: $GATEWAY_LOG"
echo "  Bridge:  $BRIDGE_LOG"
EOF
  chmod +x "$runtime_dir/start.sh"

  cat >"$runtime_dir/stop.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_PID_FILE="${RUNTIME_DIR}/pids/gateway.pid"
BRIDGE_PID_FILE="${RUNTIME_DIR}/pids/bridge.pid"

stop_pid_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return
  fi
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 0.3
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$file"
}

stop_pid_file "$GATEWAY_PID_FILE"
stop_pid_file "$BRIDGE_PID_FILE"
echo "Gateway + bridge stopped."
EOF
  chmod +x "$runtime_dir/stop.sh"

  cat >"$runtime_dir/status.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${RUNTIME_DIR}/.env.sh"

echo "Gateway port: ${OPENCLAW_CN_GATEWAY_PORT}"
echo "Bridge port:  ${OPENCLAW_CN_BRIDGE_PORT}"
echo "Gateway health:"
curl -fsS "http://127.0.0.1:${OPENCLAW_CN_GATEWAY_PORT}/health" || true
echo
echo "Bridge health:"
curl -fsS "http://127.0.0.1:${OPENCLAW_CN_BRIDGE_PORT}/health" || true
echo
EOF
  chmod +x "$runtime_dir/status.sh"

  mkdir -p "$runtime_dir/bridge"
  cp -f "$state_dir/bridge/openclaw-cn-bridge.mjs" "$runtime_dir/bridge/openclaw-cn-bridge.mjs"
}

write_profile_wrapper() {
  local profile="$1"
  local wrapper="${HOME}/.local/bin/openclaw-cn"
  local quoted_profile
  quoted_profile="$(squote "$profile")"
  mkdir -p "$(dirname "$wrapper")"
  cat >"$wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec openclaw --profile ${quoted_profile} "\$@"
EOF
  chmod +x "$wrapper"
  ensure_line_once "${HOME}/.zshrc" 'export PATH="$HOME/.local/bin:$PATH"'
}

openclaw_cfg_set() {
  local profile="$1"
  local key="$2"
  local value="$3"
  local mode="${4:-}"
  if [[ "$mode" == "json" ]]; then
    openclaw --profile "$profile" config set "$key" "$value" --json
  else
    openclaw --profile "$profile" config set "$key" "$value"
  fi
}

install_plugin_from_spec() {
  local profile="$1"
  local channel="$2"
  local spec="$3"

  if [[ -z "$spec" ]]; then
    return 1
  fi

  log "Installing ${channel} plugin from spec: ${spec}"
  if openclaw --profile "$profile" plugins install "$spec"; then
    log "Installed ${channel} plugin from spec."
    return 0
  fi

  warn "Failed to install ${channel} plugin from spec: ${spec}"
  return 1
}

onboard_and_configure() {
  local profile="$1"
  local moonshot_key="$2"
  local gateway_port="$3"
  local gateway_token="$4"
  local hook_token="$5"
  local qq_url="$6"
  local qq_token="$7"
  local ding_url="$8"
  local ding_secret="$9"
  local feishu_url="${10}"
  local feishu_secret="${11}"

  log "Running non-interactive onboarding for profile: $profile"
  openclaw --profile "$profile" onboard \
    --non-interactive \
    --accept-risk \
    --auth-choice moonshot-api-key \
    --moonshot-api-key "$moonshot_key" \
    --gateway-port "$gateway_port" \
    --gateway-bind loopback \
    --gateway-auth token \
    --gateway-token "$gateway_token" \
    --skip-channels \
    --skip-skills \
    --skip-ui \
    --skip-health \
    --skip-daemon

  openclaw_cfg_set "$profile" "hooks.enabled" "true" "json"
  openclaw_cfg_set "$profile" "hooks.path" "/hooks"
  openclaw_cfg_set "$profile" "hooks.token" "$hook_token"
  openclaw_cfg_set "$profile" "hooks.maxBodyBytes" "1048576" "json"

  if channel_enabled "qq" && [[ -n "$qq_url" ]]; then
    openclaw_cfg_set "$profile" "channels.qq.enabled" "true" "json"
    openclaw_cfg_set "$profile" "channels.qq.apiBaseUrl" "$qq_url"
    if [[ -n "$qq_token" ]]; then
      openclaw_cfg_set "$profile" "channels.qq.accessToken" "$qq_token"
    fi
  fi

  if channel_enabled "dingtalk" && [[ -n "$ding_url" ]]; then
    openclaw_cfg_set "$profile" "channels.dingtalk.enabled" "true" "json"
    openclaw_cfg_set "$profile" "channels.dingtalk.webhookUrl" "$ding_url"
    if [[ -n "$ding_secret" ]]; then
      openclaw_cfg_set "$profile" "channels.dingtalk.secret" "$ding_secret"
    fi
  fi

  if channel_enabled "feishu" && [[ -n "$feishu_url" ]]; then
    openclaw_cfg_set "$profile" "channels.feishu.enabled" "true" "json"
    openclaw_cfg_set "$profile" "channels.feishu.webhookUrl" "$feishu_url"
    if [[ -n "$feishu_secret" ]]; then
      openclaw_cfg_set "$profile" "channels.feishu.secret" "$feishu_secret"
    fi
  fi

  if ! openclaw --profile "$profile" models set "moonshot/kimi-k2.5" >/dev/null 2>&1; then
    warn "Failed to pin model to moonshot/kimi-k2.5 (this is non-fatal)."
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile)
        PROFILE="${2:-}"
        shift 2
        ;;
      --moonshot-api-key)
        MOONSHOT_API_KEY="${2:-}"
        shift 2
        ;;
      --qq-api-url)
        QQ_API_URL="${2:-}"
        shift 2
        ;;
      --qq-access-token)
        QQ_ACCESS_TOKEN="${2:-}"
        shift 2
        ;;
      --qq-plugin-spec)
        QQ_PLUGIN_SPEC="${2:-}"
        shift 2
        ;;
      --dingtalk-webhook-url)
        DINGTALK_WEBHOOK_URL="${2:-}"
        shift 2
        ;;
      --dingtalk-secret)
        DINGTALK_SECRET="${2:-}"
        shift 2
        ;;
      --dingtalk-plugin-spec)
        DINGTALK_PLUGIN_SPEC="${2:-}"
        shift 2
        ;;
      --feishu-webhook-url)
        FEISHU_WEBHOOK_URL="${2:-}"
        shift 2
        ;;
      --feishu-secret)
        FEISHU_SECRET="${2:-}"
        shift 2
        ;;
      --feishu-plugin-spec)
        FEISHU_PLUGIN_SPEC="${2:-}"
        shift 2
        ;;
      --only-channel)
        ONLY_CHANNEL="${2:-}"
        shift 2
        ;;
      --gateway-port)
        GATEWAY_PORT_INPUT="${2:-}"
        shift 2
        ;;
      --bridge-port)
        BRIDGE_PORT_INPUT="${2:-}"
        shift 2
        ;;
      --skip-start)
        SKIP_START=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
  done
}

validate_inputs() {
  [[ -n "$PROFILE" ]] || fail "--profile cannot be empty"
  case "$ONLY_CHANNEL" in
    qq|dingtalk|feishu|all) ;;
    *) fail "--only-channel must be qq|dingtalk|feishu|all" ;;
  esac

  if [[ -z "$MOONSHOT_API_KEY" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Enter Moonshot API key: " MOONSHOT_API_KEY || true
    fi
  fi
  [[ -n "$MOONSHOT_API_KEY" ]] || fail "Moonshot API key is required."

  if channel_enabled "qq" && [[ -z "$QQ_API_URL" && -t 0 ]]; then
    read -r -p "QQ OneBot API URL (optional, press Enter to skip): " QQ_API_URL || true
  fi
  if channel_enabled "dingtalk" && [[ -z "$DINGTALK_WEBHOOK_URL" && -t 0 ]]; then
    read -r -p "DingTalk webhook URL (optional, press Enter to skip): " DINGTALK_WEBHOOK_URL || true
  fi
  if channel_enabled "dingtalk" && [[ -n "$DINGTALK_WEBHOOK_URL" && -z "$DINGTALK_SECRET" && -t 0 ]]; then
    read -r -p "DingTalk webhook secret (optional, press Enter to skip): " DINGTALK_SECRET || true
  fi
  if channel_enabled "feishu" && [[ -z "$FEISHU_WEBHOOK_URL" && -t 0 ]]; then
    read -r -p "Feishu webhook URL (optional, press Enter to skip): " FEISHU_WEBHOOK_URL || true
  fi
  if channel_enabled "feishu" && [[ -n "$FEISHU_WEBHOOK_URL" && -z "$FEISHU_SECRET" && -t 0 ]]; then
    read -r -p "Feishu webhook secret (optional, press Enter to skip): " FEISHU_SECRET || true
  fi

  if [[ -n "$GATEWAY_PORT_INPUT" ]] && ! [[ "$GATEWAY_PORT_INPUT" =~ ^[0-9]+$ ]]; then
    fail "--gateway-port must be numeric"
  fi
  if [[ -n "$BRIDGE_PORT_INPUT" ]] && ! [[ "$BRIDGE_PORT_INPUT" =~ ^[0-9]+$ ]]; then
    fail "--bridge-port must be numeric"
  fi
}

main() {
  parse_args "$@"
  load_plugin_sources_file "$PLUGIN_SOURCES_FILE"

  local os
  os="$(uname -s)"
  [[ "$os" == "Darwin" ]] || fail "This script only supports macOS."
  local arch
  arch="$(uname -m)"
  if [[ "$arch" != "arm64" && "$arch" != "x86_64" ]]; then
    fail "Unsupported macOS architecture: $arch"
  fi

  need_cmd rg
  need_cmd lsof
  need_cmd curl

  validate_inputs
  refresh_path
  ensure_node22
  refresh_path
  ensure_openclaw_cli

  local state_dir
  state_dir="$(profile_state_dir "$PROFILE")"
  mkdir -p "$state_dir/extensions"
  mkdir -p "$state_dir/bridge"

  local gateway_port
  if [[ -n "$GATEWAY_PORT_INPUT" ]]; then
    gateway_port="$GATEWAY_PORT_INPUT"
    if is_port_in_use "$gateway_port"; then
      fail "Gateway port ${gateway_port} is already in use."
    fi
  else
    gateway_port="$(pick_free_port 18790)"
  fi

  local bridge_port
  if [[ -n "$BRIDGE_PORT_INPUT" ]]; then
    bridge_port="$BRIDGE_PORT_INPUT"
    if is_port_in_use "$bridge_port"; then
      fail "Bridge port ${bridge_port} is already in use."
    fi
  else
    bridge_port="$(pick_free_port 18890)"
  fi

  local gateway_token hook_token
  gateway_token="$(random_token)"
  hook_token="$(random_token)"

  onboard_and_configure \
    "$PROFILE" \
    "$MOONSHOT_API_KEY" \
    "$gateway_port" \
    "$gateway_token" \
    "$hook_token" \
    "$QQ_API_URL" \
    "$QQ_ACCESS_TOKEN" \
    "$DINGTALK_WEBHOOK_URL" \
    "$DINGTALK_SECRET" \
    "$FEISHU_WEBHOOK_URL" \
    "$FEISHU_SECRET"

  local use_local_qq=1
  local use_local_dingtalk=1
  local use_local_feishu=1

  if channel_enabled "qq" && install_plugin_from_spec "$PROFILE" "qq" "$QQ_PLUGIN_SPEC"; then
    use_local_qq=0
  fi
  if channel_enabled "dingtalk" && install_plugin_from_spec "$PROFILE" "dingtalk" "$DINGTALK_PLUGIN_SPEC"; then
    use_local_dingtalk=0
  fi
  if channel_enabled "feishu" && install_plugin_from_spec "$PROFILE" "feishu" "$FEISHU_PLUGIN_SPEC"; then
    use_local_feishu=0
  fi

  if channel_enabled "qq" && (( use_local_qq == 1 )); then
    write_qq_plugin "$state_dir/extensions"
  fi
  if channel_enabled "dingtalk" && (( use_local_dingtalk == 1 )); then
    write_dingtalk_plugin "$state_dir/extensions"
  fi
  if channel_enabled "feishu" && (( use_local_feishu == 1 )); then
    write_feishu_plugin "$state_dir/extensions"
  fi
  write_bridge_script "$state_dir/bridge"

  local runtime_dir="${state_dir}/cn-runtime"
  write_runtime_scripts "$runtime_dir" "$state_dir" "$PROFILE" "$gateway_port" "$bridge_port" "$hook_token" "$gateway_token"
  write_profile_wrapper "$PROFILE"

  if (( SKIP_START == 0 )); then
    bash "$runtime_dir/start.sh"
  fi

  log ""
  log "Install complete."
  log "Profile: $PROFILE"
  log "State dir: $state_dir"
  log "Gateway port: $gateway_port"
  log "Bridge port: $bridge_port"
  log ""
  log "Useful commands:"
  log "  openclaw-cn channels list"
  log "  bash ${runtime_dir}/status.sh"
  log "  bash ${runtime_dir}/stop.sh"
  log ""
  log "Webhook endpoints:"
  if channel_enabled "qq"; then
    log "  QQ OneBot inbound:   http://127.0.0.1:${bridge_port}/qq/onebot"
  fi
  if channel_enabled "dingtalk"; then
    log "  DingTalk inbound:    http://127.0.0.1:${bridge_port}/dingtalk/inbound"
  fi
  if channel_enabled "feishu"; then
    log "  Feishu inbound:      http://127.0.0.1:${bridge_port}/feishu/inbound"
  fi
}

main "$@"
