# Kim Channel Extension for OpenClaw

Kim 企业通讯平台的 OpenClaw 渠道扩展，支持双向消息收发、Webhook 入站和配对鉴权。

## Features

- Inbound webhook routing (`/webhook/kim`)
- Outbound text/image replies (mixCard)
- Callback token verification (header/query/body token candidates)
- DM pairing policy (`open` / `allowlist` / `pairing`)
- Pairing store integration (`~/.openclaw/credentials/kim-allowFrom.json`)
- Duplicate inbound event suppression
- Placeholder interactive event filtering
- Username fallback mapping via `replyUsernamesById`

## Install

Kim extension is loaded from workspace extension registration:

```json
{
  "openclaw": {
    "extensions": ["./extensions/kim/index.ts"]
  }
}
```

For local development:

```bash
pnpm install
pnpm -s build
```

## Config

Edit `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "kim": {
      "enabled": true,
      "appKey": "YOUR_KIM_APP_KEY",
      "secretKey": "YOUR_KIM_SECRET_KEY",
      "environment": "production",
      "callbackUrl": "http://YOUR_GATEWAY_HOST:18789/webhook/kim",
      "callbackToken": "YOUR_64_HEX_RANDOM_TOKEN",
      "replyUsernamesById": {
        "872858283717": "your-real-kim-username"
      },
      "dm": {
        "policy": "pairing",
        "allowFrom": []
      },
      "groupPolicy": "allowlist",
      "allowedGroups": []
    }
  },
  "logging": {
    "consoleLevel": "info"
  }
}
```

## Pairing Flow

When `channels.kim.dm.policy` is `pairing`:

1. Unknown sender sends first DM.
2. Kim channel returns pairing code.
3. Approve in gateway host:

```bash
openclaw pairing list kim
openclaw pairing approve kim <code>
```

4. Sender ID is persisted to pairing store:
   `~/.openclaw/credentials/kim-allowFrom.json`

## Webhook Health Check

```bash
curl -i http://127.0.0.1:18789/webhook/kim
```

Expected:

```json
{"status":0,"message":"Kim webhook is running","data":{}}
```

## Useful Logs

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | grep -E \
"Kim webhook POST received|Kim webhook parsed|Kim webhook rejected|kim: inbound|kim final reply failed"
```

## Troubleshooting

- `Kim webhook rejected: invalid callback token`:
  callback token mismatch or request missing token.
- `kim: inbound blocked by channel policy`:
  sender not in config allowlist or pairing store.
- `username=...获取userid失败`:
  missing/invalid username mapping, configure `replyUsernamesById`.
- `unknown command 'pair'`:
  `/pair` is not an OpenClaw command, use `openclaw pairing approve kim <code>`.

## Files

- `extensions/kim/index.ts`: plugin entry
- `extensions/kim/src/channel.ts`: channel definition, webhook route, security/pairing metadata
- `extensions/kim/src/inbound.ts`: inbound policy, routing, reply dispatch
- `extensions/kim/src/webhook.ts`: callback token validation + event parsing
- `extensions/kim/src/client.ts`: Kim API client with token refresh + retries
- `extensions/kim/src/converter.ts`: webhook and mixCard conversion
