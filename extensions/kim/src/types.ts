// Kim API 类型定义

// ==================== MixCard 消息类型 ====================

export interface MixCard {
  blocks: MixCardBlock[];
  config: MixCardConfig;
  updateMulti: number;
  appKey: string;
  timestamp?: number;
}

export interface MixCardBlock {
  blockId: string;
  type: "content" | "image" | "action";
  text?: {
    type: "plainText" | "kimMd";
    content: string;
    i18n?: Record<string, string>;
    small?: boolean;
  };
  image?: {
    url: string;
    width?: number;
    height?: number;
    type?: string;
  };
  actions?: MixCardAction[];
  elements?: MixCardElement[];
  remark?: boolean;
  click?: boolean;
  title?: string;
}

export interface MixCardAction {
  type: "button";
  text: {
    type: "plain_text";
    content: string;
  };
  style?: "primary" | "default" | "danger";
  value?: Record<string, unknown>;
}

export interface MixCardElement {
  type: "kimMd" | "plainText";
  content: string;
}

export interface MixCardConfig {
  forward: boolean;
  forwardType?: "callback" | number;
  cardUrl?: {
    url?: string;
    multiUrl?: {
      pc?: string;
      android?: string;
      ios?: string;
    };
  };
  wideSelfAdaptive?: boolean;
}

// ==================== Webhook 事件类型 ====================

export interface KimWebhookEvent {
  uuid: string;
  timestamp: number;
  appId: string;
  type: "cardChanged" | "messageReceived";
  info: {
    messageKey: string;
    sessionType: number; // 0=direct, 1=group
    session: {
      from: number;
      to: number;
      groupId?: number;
    };
    operator?: {
      userId: number;
      username: string;
    };
    actionValue?: Record<string, unknown>;
    globalValue?: Record<string, unknown>;
    mixCard?: MixCard;
    forward?: {
      senderId: number;
      forwarder: number;
      usernames: string[];
      groupIds: number[];
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface KimWebhookResponse {
  status: number; // 0=success, other=error
  message: string;
  data: {
    type?: string;
    updateMulti?: number;
    card?: {
      toast?: {
        zhCN: string;
        enUS: string;
      };
      operation?: {
        url?: string;
        multiUrl?: {
          pc?: string;
          android?: string;
          ios?: string;
        };
      };
      messageKey?: string;
      operatorId?: number;
      blocks?: MixCardBlock[];
      timestamp?: number;
    };
    host?: string;
  };
}

// ==================== API 请求/响应类型 ====================

export interface KimApiConfig {
  appKey: string;
  secretKey: string;
  environment: "staging" | "production";
  baseUrl?: string; // 可选的自定义 API 地址
}

// AccessToken 认证相关类型
export interface AccessTokenRequest {
  appKey: string;
  secretKey: string;
}

export interface AccessTokenResponse {
  status: number;
  message: string;
  data?: {
    accessToken: string;
    expireTime: number; // 过期时间（毫秒时间戳）
  };
}

export interface SendMessageRequest {
  username: string;
  mixCard: MixCard;
  replyTo?: string;
  msgType?: "mixCard";
}

export interface SendMessageResponse {
  status: number;
  message: string;
  messageKey?: string;
  data?: unknown;
}

export interface RegisterCallbackRequest {
  callBackUrl: string;
  callBackToken?: string;
}

export interface BotInfo {
  botId?: string;
  botName?: string;
  appKey?: string;
  permissions?: string[];
}

// ==================== OpenClaw Message 类型 ====================

export interface OpenClawMessage {
  id: string;
  text: string;
  author: {
    id: string;
    name: string;
  };
  channel: string;
  timestamp: Date;
  sessionType: "direct" | "group";
  groupId?: string;
  metadata?: {
    actionValue?: Record<string, unknown>;
    messageKey?: string;
    senderUsername?: string;
  };
}

// ==================== Account 配置类型 ====================

export interface KimAccountConfig {
  appKey: string;
  secretKey: string;
  environment: "staging" | "production";
  callbackUrl?: string;
  callbackToken?: string;
  replyUsernamesById?: Record<string, string>;
  enabled?: boolean;
  name?: string;
}

export interface ResolvedKimAccount {
  accountId: string;
  appKey: string;
  secretKey: string;
  environment: "staging" | "production";
  callbackUrl?: string;
  callbackToken?: string;
  enabled: boolean;
  name?: string;
  config: {
    dm?: {
      policy?: "pairing" | "open" | "allowlist";
      allowFrom?: string[];
    };
    groupPolicy?: "open" | "allowlist";
    allowedGroups?: string[];
    replyUsernamesById?: Record<string, string>;
  };
}
