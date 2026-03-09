import type { IncomingHttpHeaders } from "node:http";
import type { KimWebhookEvent, KimWebhookResponse, OpenClawMessage } from "./types.js";
import { MessageConverter } from "./converter.js";

type CallbackTokenCandidate = {
  source: string;
  value: string;
};

type CallbackValidationResult = {
  valid: boolean;
  matchedBy?: string;
  candidates: CallbackTokenCandidate[];
};
/**
 * Webhook 处理器
 * 负责接收和处理 Kim 的 Webhook 回调
 */
export class WebhookHandler {
  private static normalizeSessionType(
    sessionType: unknown,
    session?: { groupId?: unknown },
  ): number {
    if (typeof sessionType === "number") {
      return sessionType === 0 ? 0 : 1;
    }
    if (typeof sessionType === "string") {
      const raw = sessionType.trim().toLowerCase();
      if (["0", "p2p", "dm", "direct", "private", "single"].includes(raw)) {
        return 0;
      }
      if (["1", "group", "groupchat", "chatgroup", "team"].includes(raw)) {
        return 1;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed === 0 ? 0 : 1;
      }
    }
    if (session?.groupId !== undefined && session?.groupId !== null) {
      return 1;
    }
    return 0;
  }

  /**
   * 验证 Webhook 请求的 Token
   */
  static validateCallbackDetailed(
    headers: IncomingHttpHeaders,
    expectedToken?: string,
    rawUrl?: string,
    rawBody?: string,
  ): CallbackValidationResult {
    const expected = this.normalizeToken(expectedToken);
    if (!expected) {
      return { valid: true, matchedBy: "disabled", candidates: [] };
    }
    const candidates = this.collectTokenCandidates(headers, rawUrl, rawBody);
    for (const candidate of candidates) {
      if (this.tokensEqual(expected, candidate.value)) {
        return {
          valid: true,
          matchedBy: candidate.source,
          candidates,
        };
      }
    }
    return { valid: false, candidates };
  }

  static validateCallback(
    headers: IncomingHttpHeaders,
    expectedToken?: string,
    rawUrl?: string,
    rawBody?: string,
  ): boolean {
    return this.validateCallbackDetailed(headers, expectedToken, rawUrl, rawBody).valid;
  }

  private static collectTokenCandidates(
    headers: IncomingHttpHeaders,
    rawUrl?: string,
    rawBody?: string,
  ): CallbackTokenCandidate[] {
    const candidates: CallbackTokenCandidate[] = [];
    const push = (source: string, value: string | undefined) => {
      const normalized = this.normalizeToken(value);
      if (!normalized) {
        return;
      }
      candidates.push({ source, value: normalized });
    };

    const readHeader = (name: string): string[] => {
      const v = headers[name];
      if (!v) {
        return [];
      }
      if (Array.isArray(v)) {
        return v.filter((entry): entry is string => typeof entry === "string");
      }
      return typeof v === "string" ? [v] : [];
    };

    for (const name of ["x-auth-token", "x-kim-auth-token", "x-kim-token", "auth-token"]) {
      for (const value of readHeader(name)) {
        push(`header:${name}`, value);
      }
    }

    for (const authValue of readHeader("authorization")) {
      push("header:authorization", authValue);
      const bearer = authValue.match(/^\s*(Bearer|Token)\s+(.+)\s*$/i);
      if (bearer?.[2]) {
        push("header:authorization-bearer", bearer[2]);
      }
    }

    if (rawUrl) {
      try {
        const url = new URL(rawUrl, "http://localhost");
        for (const key of [
          "callBackToken",
          "callbackToken",
          "token",
          "authToken",
          "x-auth-token",
        ]) {
          push(`query:${key}`, url.searchParams.get(key) ?? undefined);
        }
      } catch {
        // ignore malformed url
      }
    }

    if (rawBody?.trim()) {
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        const tokenKeys = new Set([
          "callBackToken",
          "callbackToken",
          "authToken",
          "xAuthToken",
          "x-auth-token",
          "signature",
          "sign",
          "token",
        ]);
        const visit = (value: unknown, path: string[]) => {
          if (!value || typeof value !== "object") {
            return;
          }
          if (Array.isArray(value)) {
            value.forEach((entry, idx) => visit(entry, [...path, String(idx)]));
            return;
          }
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (typeof v === "string" && tokenKeys.has(k)) {
              push(`body:${[...path, k].join(".")}`, v);
            }
            visit(v, [...path, k]);
          }
        };
        visit(parsed, []);
      } catch {
        // ignore non-json body
      }
    }

    return candidates;
  }

  private static normalizeToken(value?: string): string {
    if (!value) {
      return "";
    }
    let token = value.trim();
    if (token.startsWith('"') && token.endsWith('"') && token.length > 1) {
      token = token.slice(1, -1);
    }
    return token.trim();
  }

  private static tokensEqual(expected: string, actual: string): boolean {
    if (expected === actual) {
      return true;
    }
    const hex = /^[0-9a-f]+$/i;
    if (hex.test(expected) && hex.test(actual)) {
      return expected.toLowerCase() === actual.toLowerCase();
    }
    return false;
  }

  /**
   * 处理 Webhook 事件
   */
  static async handleEvent(
    event: KimWebhookEvent,
    onMessage: (msg: OpenClawMessage, event: KimWebhookEvent) => Promise<void>,
  ): Promise<KimWebhookResponse> {
    try {
      // 转换为 OpenClaw 消息格式
      const message = MessageConverter.fromWebhook(event);

      // 调用消息处理回调
      await onMessage(message, event);

      // 根据事件类型返回不同的响应
      switch (event.type) {
        case "cardChanged":
          return this.buildSuccessResponse({
            toast: "操作成功",
            updateCard: false,
          });

        case "messageReceived":
          return this.buildSuccessResponse();

        default:
          console.warn("[Kim Webhook] Unhandled event type");
          return this.buildSuccessResponse();
      }
    } catch (error) {
      console.error("[Kim Webhook] Error handling event:", error);
      return this.buildErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 构造成功响应
   */
  private static buildSuccessResponse(opts?: {
    toast?: string;
    updateCard?: boolean;
  }): KimWebhookResponse {
    const response: KimWebhookResponse = {
      status: 0,
      message: "success",
      data: {
        type: "cardChanged",
        updateMulti: 0,
      },
    };

    // 添加 Toast 提示
    if (opts?.toast) {
      response.data.card = {
        toast: {
          zhCN: opts.toast,
          enUS: opts.toast,
        },
      };
    }

    return response;
  }

  /**
   * 构造错误响应
   */
  private static buildErrorResponse(error: string): KimWebhookResponse {
    return {
      status: 1,
      message: error,
      data: {},
    };
  }

  /**
   * 验证 Webhook 事件格式
   */
  static validateEvent(event: unknown): { valid: boolean; errors: string[] } {
    const candidate = event as Partial<KimWebhookEvent> & {
      info?: Partial<KimWebhookEvent["info"]>;
    };
    const errors: string[] = [];

    if (!candidate.type) {
      errors.push("Missing type");
    }
    if (!candidate.info) {
      errors.push("Missing info");
    } else {
      if (candidate.info.sessionType === undefined) {
        errors.push("Missing info.sessionType");
      }
      if (!candidate.info.session) {
        errors.push("Missing info.session");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 解析 Webhook 请求体
   */
  static parseWebhookBody(body: string): KimWebhookEvent {
    try {
      const parsed = JSON.parse(body) as Partial<KimWebhookEvent>;
      const rawInfo = (parsed.info ?? {}) as Record<string, unknown>;
      const event = {
        uuid: parsed.uuid ?? `kim-${Date.now()}`,
        timestamp: parsed.timestamp ?? Date.now(),
        appId: parsed.appId ?? "",
        type: parsed.type ?? "messageReceived",
        info: {
          ...rawInfo,
          messageKey:
            (typeof rawInfo.messageKey === "string" && rawInfo.messageKey.trim()) ||
            parsed.info?.messageKey ||
            `kim-${Date.now()}`,
          sessionType: this.normalizeSessionType(
            rawInfo.sessionType ?? parsed.info?.sessionType,
            (rawInfo.session as { groupId?: unknown } | undefined) ??
              (parsed.info?.session as { groupId?: unknown } | undefined),
          ),
          session: (rawInfo.session as KimWebhookEvent["info"]["session"] | undefined) ??
            parsed.info?.session ?? { from: 0, to: 0 },
          operator:
            (rawInfo.operator as KimWebhookEvent["info"]["operator"] | undefined) ??
            parsed.info?.operator,
          actionValue:
            (rawInfo.actionValue as KimWebhookEvent["info"]["actionValue"] | undefined) ??
            parsed.info?.actionValue,
          globalValue:
            (rawInfo.globalValue as KimWebhookEvent["info"]["globalValue"] | undefined) ??
            parsed.info?.globalValue,
          mixCard:
            (rawInfo.mixCard as KimWebhookEvent["info"]["mixCard"] | undefined) ??
            parsed.info?.mixCard,
          forward:
            (rawInfo.forward as KimWebhookEvent["info"]["forward"] | undefined) ??
            parsed.info?.forward,
        },
      } as KimWebhookEvent;

      const validation = this.validateEvent(event);
      if (!validation.valid) {
        throw new Error(`Invalid webhook event: ${validation.errors.join(", ")}`);
      }

      return event;
    } catch (error) {
      throw new Error(
        `Failed to parse webhook body: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
