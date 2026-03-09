import type { MixCard, KimWebhookEvent, OpenClawMessage } from "./types.js";

/**
 * 消息转换参数
 */
export interface ConvertToMixCardParams {
  text?: string;
  imageUrl?: string;
  buttons?: Array<{ label: string; value: string; style?: "primary" | "default" | "danger" }>;
  appKey: string;
}

/**
 * 消息转换器
 * 负责 OpenClaw Message 和 Kim MixCard 的双向转换
 */
export class MessageConverter {
  private static readonly MAX_TEXT_LENGTH = 4096; // Kim MixCard 文本长度限制
  private static readonly MAX_BUTTONS = 10; // 最大按钮数量
  private static readonly TEXT_FIELD_BLACKLIST = new Set([
    "messagekey",
    "msgtype",
    "messagetype",
    "type",
  ]);
  private static readonly TEXT_FIELD_HINT_RE =
    /(text|content|message|msg|body|value|title|label|desc|description)/i;

  private static isGroupSessionType(sessionType: unknown, groupId?: unknown): boolean {
    if (typeof sessionType === "number") {
      return sessionType !== 0;
    }
    if (typeof sessionType === "string") {
      const raw = sessionType.trim().toLowerCase();
      if (["0", "p2p", "dm", "direct", "private", "single"].includes(raw)) {
        return false;
      }
      if (["1", "group", "groupchat", "chatgroup", "team"].includes(raw)) {
        return true;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed !== 0;
      }
    }
    return groupId !== undefined && groupId !== null;
  }

  /**
   * OpenClaw Message → Kim MixCard
   */
  static toMixCard(params: ConvertToMixCardParams): MixCard {
    const blocks: MixCard["blocks"] = [];

    // 处理文本内容
    if (params.text !== undefined) {
      const textBlock = this.createTextBlock(params.text);
      if (textBlock) {
        blocks.push(textBlock);
      }
    }

    // 处理图片
    if (params.imageUrl) {
      blocks.push(this.createImageBlock(params.imageUrl));
    }

    // 处理按钮
    if (params.buttons && params.buttons.length > 0) {
      const actionBlock = this.createActionBlock(params.buttons);
      if (actionBlock) {
        blocks.push(actionBlock);
      }
    }

    // 如果没有任何内容，添加默认占位符
    if (blocks.length === 0) {
      const fallback = this.createTextBlock("[Empty Message]");
      if (fallback) {
        blocks.push(fallback);
      }
    }

    return {
      blocks,
      config: {
        forward: true,
        // Kim API requires numeric forwardType for mixCard (must be 2 or 3).
        forwardType: 2,
      },
      updateMulti: 1, // 独占刷新模式
      appKey: params.appKey,
    };
  }

  /**
   * 创建文本块
   */
  private static createTextBlock(text: string): MixCard["blocks"][number] | null {
    let content = text.trim();

    // 空文本处理
    if (content.length === 0) {
      return null;
    }

    // 超长文本截断
    if (content.length > this.MAX_TEXT_LENGTH) {
      content = content.substring(0, this.MAX_TEXT_LENGTH - 20) + "\n\n[文本过长已截断...]";
    }

    return {
      blockId: this.generateBlockId(),
      type: "content",
      text: {
        type: "plainText",
        content,
      },
      remark: false,
      click: false,
    };
  }

  /**
   * 创建图片块
   */
  private static createImageBlock(imageUrl: string): MixCard["blocks"][number] {
    return {
      blockId: this.generateBlockId(),
      type: "image",
      image: {
        url: imageUrl,
        type: "image",
      },
    };
  }

  /**
   * 创建交互式按钮块
   */
  private static createActionBlock(
    buttons: Array<{ label: string; value: string; style?: "primary" | "default" | "danger" }>,
  ): MixCard["blocks"][number] | null {
    if (buttons.length === 0) {
      return null;
    }

    // 限制按钮数量
    const limitedButtons = buttons.slice(0, this.MAX_BUTTONS);

    return {
      blockId: this.generateBlockId(),
      type: "action",
      actions: limitedButtons.map((btn) => ({
        type: "button",
        text: {
          type: "plain_text",
          content: btn.label,
        },
        style: btn.style || "default",
        value: { action: btn.value },
      })),
    };
  }

  /**
   * Kim Webhook Event → OpenClaw Message
   */
  static fromWebhook(event: KimWebhookEvent): OpenClawMessage {
    const { info } = event;
    const isGroupSession = this.isGroupSessionType(
      info.sessionType as unknown,
      info.session.groupId,
    );

    // 提取文本内容
    const text = this.extractTextFromWebhook(info);

    // 提取发送者信息
    const senderId = info.operator?.userId ?? info.session.from;
    const senderUsername = info.operator?.username ?? `user_${senderId}`;

    return {
      id: info.messageKey,
      text,
      author: {
        id: String(senderId),
        name: senderUsername,
      },
      channel: "kim",
      timestamp: new Date(event.timestamp),
      sessionType: isGroupSession ? "group" : "direct",
      groupId: info.session.groupId ? String(info.session.groupId) : undefined,
      metadata: {
        actionValue: info.actionValue,
        messageKey: info.messageKey,
        senderUsername: info.operator?.username,
      },
    };
  }

  /**
   * 从 Webhook 事件中提取文本内容
   */
  private static extractTextFromWebhook(info: KimWebhookEvent["info"]): string {
    // 优先从 mixCard 的 blocks 中提取
    if (info.mixCard?.blocks) {
      const textBlocks = info.mixCard.blocks
        .filter((block) => block.type === "content" && block.text)
        .map((block) => block.text!.content);

      if (textBlocks.length > 0) {
        return textBlocks.join("\n");
      }
    }

    // 从 actionValue 中提取（用户点击按钮）
    if (info.actionValue) {
      if (typeof info.actionValue.action === "string") {
        return `[Action: ${info.actionValue.action}]`;
      }
      return JSON.stringify(info.actionValue);
    }

    // 常见文本字段兜底（不同 Kim webhook 版本字段可能不同）
    const fallbackText = this.extractTextByKnownFields(info);
    if (fallbackText) {
      return fallbackText;
    }

    // 深度扫描包含 text/content/message/msg/body 的字符串字段
    const deepText = this.extractTextByDeepScan(info);
    if (deepText) {
      return deepText;
    }

    // 默认返回
    return "[Interactive Event]";
  }

  private static extractTextByKnownFields(info: KimWebhookEvent["info"]): string | null {
    const candidatePaths = [
      ["text"],
      ["content"],
      ["message"],
      ["msg"],
      ["body"],
      ["plainText"],
      ["textContent"],
      ["messageContent"],
      ["msgContent"],
      ["data", "text"],
      ["data", "content"],
      ["data", "message"],
      ["payload", "text"],
      ["payload", "content"],
      ["payload", "message"],
      ["event", "text"],
      ["event", "content"],
      ["event", "message"],
    ];
    for (const path of candidatePaths) {
      const value = this.readPath(info as unknown as Record<string, unknown>, path);
      if (typeof value !== "string") {
        continue;
      }
      const normalized = this.normalizeExtractedText(value);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private static readPath(root: Record<string, unknown>, path: string[]): unknown {
    let cur: unknown = root;
    for (const segment of path) {
      if (!cur || typeof cur !== "object") {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[segment];
    }
    return cur;
  }

  private static extractTextByDeepScan(info: KimWebhookEvent["info"]): string | null {
    const candidates: string[] = [];
    const visit = (value: unknown, keyPath: string[]) => {
      if (typeof value === "string") {
        const key = keyPath[keyPath.length - 1]?.toLowerCase() ?? "";
        if (!this.TEXT_FIELD_HINT_RE.test(key)) {
          return;
        }
        if (this.TEXT_FIELD_BLACKLIST.has(key)) {
          return;
        }
        const normalized = this.normalizeExtractedText(value);
        if (normalized) {
          candidates.push(normalized);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          visit(entry, keyPath);
        }
        return;
      }
      if (!value || typeof value !== "object") {
        return;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, [...keyPath, k]);
      }
    };

    visit(info as unknown, []);
    if (!candidates.length) {
      return null;
    }
    return candidates[0] ?? null;
  }

  private static normalizeExtractedText(value: string): string | null {
    const text = value.trim();
    if (!text) {
      return null;
    }
    if (/^OMSG_[A-Za-z0-9+/=]+$/.test(text)) {
      return null;
    }
    if (/^kim-\d+$/.test(text)) {
      return null;
    }
    if (text === "messageReceived" || text === "[Interactive Event]") {
      return null;
    }
    return text;
  }

  /**
   * 生成唯一的 Block ID
   */
  private static generateBlockId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `block_${timestamp}_${random}`;
  }

  /**
   * 验证 MixCard 格式
   */
  static validateMixCard(mixCard: MixCard): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!mixCard.blocks || mixCard.blocks.length === 0) {
      errors.push("MixCard must have at least one block");
    }

    if (!mixCard.appKey) {
      errors.push("MixCard must have appKey");
    }

    mixCard.blocks?.forEach((block, index) => {
      if (!block.blockId) {
        errors.push(`Block ${index} missing blockId`);
      }
      if (!block.type) {
        errors.push(`Block ${index} missing type`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
