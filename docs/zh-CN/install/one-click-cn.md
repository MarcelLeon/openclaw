---
summary: "中国用户极简一键安装：按 QQ/钉钉/飞书三种脚本选择"
read_when:
  - 你是第一次安装
  - 你希望只执行一条命令
title: "中国用户一键安装（极简版）"
---

# 中国用户一键安装（极简版）

## 先准备（只看这三条）

1. 你有一个可登录的聊天账号（QQ / 钉钉 / 飞书，三选一）。
2. 你有 Moonshot API Key（先去官网注册并支付，再回来）。
3. 打开 macOS 的 Terminal，进入本仓库目录。

## 只执行一条命令

### 我只用 QQ

```bash
bash scripts/openclaw_qq_install.sh
```

### 我只用钉钉

```bash
bash scripts/openclaw_dingtalk_install.sh
```

### 我只用飞书

```bash
bash scripts/openclaw_feishu_install.sh
```

脚本会自动处理环境安装、OpenClaw 初始化、插件安装（可用时自动安装，失败自动回退内置方案）。

## 安装时你只需要填

1. Moonshot API Key（必填）
2. 对应 IM 的地址（可选，可后补）

对应 IM 的地址是什么：

- QQ：OneBot API 地址，例如 `http://127.0.0.1:5700`
- 钉钉：机器人 Webhook 地址，例如 `https://oapi.dingtalk.com/robot/send?access_token=...`
- 飞书：机器人 Webhook 地址，例如 `https://open.feishu.cn/open-apis/bot/v2/hook/...`

如果你当下没有 IM 地址，先回车跳过也可以，后面再补。

## 完成后常用命令

```bash
openclaw-cn channels list
```

如果命令不存在，重开一个 Terminal 再试一次。

## 注意

- 这些脚本默认使用独立配置目录，不会覆盖你已有默认配置。
- QQ/钉钉/飞书都依赖你自己的账号与机器人配置；脚本不会代你注册账号或支付。

## 相关文档

- [安装总览](/install)
- [Moonshot 提供商](/providers/moonshot)
