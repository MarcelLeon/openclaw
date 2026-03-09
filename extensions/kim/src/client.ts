import axios, { AxiosInstance, AxiosError } from "axios";
import type {
  KimApiConfig,
  SendMessageRequest,
  SendMessageResponse,
  RegisterCallbackRequest,
  BotInfo,
} from "./types.js";

/**
 * Kim API 客户端（正确版本）
 *
 * 认证流程：
 * 1. 获取 AccessToken: GET https://is-gateway.corp.kuaishou.com/token/get?appKey=xxx&secretKey=xxx
 * 2. 使用 Token: 所有业务 API 请求都通过 is-gateway.corp.kuaishou.com，Header 添加 Authorization: Bearer {token}
 *
 * 注意：
 * - expireTime 是相对时间（秒），不是绝对时间戳
 * - 所有 API（包括业务接口）都使用统一的 Gateway 地址
 */
export class KimApiClient {
  private httpClient: AxiosInstance;
  private appKey: string;
  private secretKey: string;
  private gatewayUrl: string;

  // AccessToken 管理
  private accessToken: string | null = null;
  private tokenExpireTime: number = 0; // 绝对过期时间（毫秒时间戳）
  private tokenRefreshPromise: Promise<void> | null = null;

  constructor(config: KimApiConfig) {
    this.appKey = config.appKey;
    this.secretKey = config.secretKey;

    // 根据官方文档，所有 API 都通过统一的 Gateway
    this.gatewayUrl =
      config.baseUrl ??
      (config.environment === "staging"
        ? "https://is-gateway-test.corp.kuaishou.com"
        : "https://is-gateway.corp.kuaishou.com");

    // 创建 HTTP 客户端
    this.httpClient = axios.create({
      baseURL: this.gatewayUrl,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // 请求拦截器：自动添加 Bearer Token
    this.httpClient.interceptors.request.use(async (config) => {
      // 跳过 token/get 请求的认证
      if (config.url?.includes("/token/get")) {
        return config;
      }

      // 确保 Token 有效
      await this.ensureValidToken();

      if (this.accessToken) {
        config.headers["Authorization"] = `Bearer ${this.accessToken}`;
      }

      return config;
    });

    // 响应拦截器：统一错误处理
    this.httpClient.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        if (error.response) {
          const status = error.response.status;
          const data = error.response.data as { message?: string } | undefined;

          // 401 错误：Token 可能过期，尝试刷新后重试
          if (status === 401) {
            // 重置 Token 并重试一次
            this.accessToken = null;
            this.tokenExpireTime = 0;

            if (error.config && !error.config.headers["X-Retry-After-Token-Refresh"]) {
              try {
                await this.ensureValidToken();
                error.config.headers["X-Retry-After-Token-Refresh"] = "true";
                error.config.headers["Authorization"] = `Bearer ${this.accessToken}`;
                return this.httpClient.request(error.config);
              } catch (retryError) {
                throw new Error(
                  `Kim API Authentication failed: ${data?.message || error.message}`,
                  {
                    cause: retryError,
                  },
                );
              }
            }

            throw new Error(`Kim API Authentication failed: ${data?.message || error.message}`);
          } else if (status === 403) {
            throw new Error(`Kim API Permission denied: ${data?.message || error.message}`);
          } else if (status === 404) {
            throw new Error(`Kim API endpoint not found: ${error.config?.url}`);
          } else if (status >= 500) {
            throw new Error(`Kim API server error (${status}): ${data?.message || error.message}`);
          }
        } else if (error.code === "ECONNABORTED") {
          throw new Error("Kim API request timeout");
        } else if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
          throw new Error(`Kim API connection failed: ${this.gatewayUrl}`);
        }

        throw error;
      },
    );
  }

  /**
   * 确保 AccessToken 有效
   * 如果 Token 不存在或即将过期（提前 5 分钟刷新），则获取新 Token
   */
  private async ensureValidToken(): Promise<void> {
    const now = Date.now();
    const refreshThreshold = 5 * 60 * 1000; // 提前 5 分钟刷新

    // Token 仍然有效
    if (this.accessToken && this.tokenExpireTime > now + refreshThreshold) {
      return;
    }

    // 如果正在刷新，等待刷新完成
    if (this.tokenRefreshPromise) {
      await this.tokenRefreshPromise;
      return;
    }

    // 开始刷新 Token
    this.tokenRefreshPromise = this.refreshAccessToken();

    try {
      await this.tokenRefreshPromise;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  /**
   * 获取新的 AccessToken
   *
   * 根据官方文档：
   * - 请求方式: GET
   * - URL: /token/get?appKey=xxx&secretKey=xxx
   * - 响应: { code: 0, result: { accessToken: "...", expireTime: 43200 } }
   * - expireTime 单位是秒（相对时间）
   */
  private async refreshAccessToken(): Promise<void> {
    try {
      console.log("[Kim] Fetching new AccessToken...");

      const response = await this.httpClient.get("/token/get", {
        params: {
          appKey: this.appKey,
          secretKey: this.secretKey,
        },
      });

      const data = response.data as {
        code?: number;
        message?: string;
        result?: {
          accessToken?: string;
          expireTime?: number;
        };
      };

      if (data.code !== 0 || !data.result?.accessToken) {
        throw new Error(`Failed to get AccessToken: ${data.message ?? "unknown error"}`);
      }

      this.accessToken = data.result.accessToken;

      // expireTime 是相对时间（秒），转换为绝对时间戳（毫秒）
      const expireTimeSeconds = data.result.expireTime ?? 0;
      this.tokenExpireTime = Date.now() + expireTimeSeconds * 1000;

      const expiresIn = Math.floor(expireTimeSeconds / 60);
      console.log(`[Kim] AccessToken obtained, expires in ${expiresIn} minutes`);
    } catch (error) {
      this.accessToken = null;
      this.tokenExpireTime = 0;
      throw this.wrapError(error, "refreshAccessToken");
    }
  }

  /**
   * 发送消息
   */
  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    try {
      const response = await this.httpClient.post<SendMessageResponse>("/openapi/v2/message/send", {
        username: req.username,
        msgType: req.msgType || "mixCard",
        mixCard: req.mixCard,
      });

      if (response.data.status !== 0) {
        throw new Error(`Kim API Error: ${response.data.message}`);
      }

      return response.data;
    } catch (error) {
      throw this.wrapError(error, "sendMessage");
    }
  }

  /**
   * 带重试的发送消息
   * 使用指数退避算法
   */
  async sendMessageWithRetry(
    req: SendMessageRequest,
    maxRetries = 3,
  ): Promise<SendMessageResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.sendMessage(req);
      } catch (error) {
        lastError = error as Error;

        // 最后一次尝试，直接抛出错误
        if (attempt === maxRetries - 1) {
          break;
        }

        // 判断是否应该重试
        if (!this.shouldRetry(error)) {
          throw error;
        }

        // 指数退避：1s, 2s, 4s
        const delay = 1000 * Math.pow(2, attempt);
        await this.sleep(delay);

        console.log(`[Kim] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
      }
    }

    throw lastError!;
  }

  /**
   * 注册 Webhook 回调地址
   */
  async registerCallback(opts: RegisterCallbackRequest): Promise<void> {
    try {
      await this.httpClient.post("/openapi/v2/interactive/callback/info", {
        callBackUrl: opts.callBackUrl,
        callBackToken: opts.callBackToken || "",
      });
    } catch (error) {
      throw this.wrapError(error, "registerCallback");
    }
  }

  /**
   * 查询回调地址配置
   */
  async getCallbackInfo(): Promise<{ callBackUrl: string; callBackToken: string }> {
    try {
      const response = await this.httpClient.get("/openapi/v2/interactive/callback/info");
      return response.data;
    } catch (error) {
      throw this.wrapError(error, "getCallbackInfo");
    }
  }

  /**
   * 验证凭证有效性
   * 通过尝试获取 AccessToken 来验证
   */
  async verifyCredentials(): Promise<void> {
    try {
      // 清空现有 Token
      this.accessToken = null;
      this.tokenExpireTime = 0;

      // 尝试获取新 Token
      await this.refreshAccessToken();

      console.log("[Kim] Credentials verified successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Failed to get AccessToken")) {
        throw new Error("Invalid Kim credentials: AppKey or SecretKey is incorrect", {
          cause: error,
        });
      }
      throw this.wrapError(error, "verifyCredentials");
    }
  }

  /**
   * 获取 Bot 信息
   * 目前暂时返回空对象，避免接口不存在的错误
   */
  async getBotInfo(_timeoutMs?: number): Promise<BotInfo> {
    try {
      // 暂时返回空的 BotInfo，避免接口不存在的错误
      return {
        botId: "",
        botName: "",
        appKey: this.appKey,
        status: "active",
      };
    } catch (error) {
      throw this.wrapError(error, "getBotInfo");
    }
  }

  /**
   * 撤回消息
   */
  async recallMessage(messageKey: string): Promise<void> {
    try {
      await this.httpClient.post("/openapi/v2/message/recall", {
        messageKey,
      });
    } catch (error) {
      throw this.wrapError(error, "recallMessage");
    }
  }

  /**
   * 获取当前 AccessToken（用于调试）
   */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * 获取 Token 过期时间（用于调试）
   */
  getTokenExpireTime(): number {
    return this.tokenExpireTime;
  }

  /**
   * 判断错误是否应该重试
   */
  private shouldRetry(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const resolved = error as { code?: string; response?: { status?: number } };

    // 网络错误：重试
    if (resolved.code === "ECONNABORTED" || resolved.code === "ETIMEDOUT") {
      return true;
    }

    // 5xx 服务器错误：重试
    if ((resolved.response?.status ?? 0) >= 500) {
      return true;
    }

    // 429 限流错误：重试
    if (resolved.response?.status === 429) {
      return true;
    }

    // 4xx 客户端错误：不重试
    if ((resolved.response?.status ?? 0) >= 400 && (resolved.response?.status ?? 0) < 500) {
      return false;
    }

    // 其他错误：不重试
    return false;
  }

  /**
   * 包装错误，添加上下文信息
   */
  private wrapError(error: unknown, operation: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error) {
      return new Error(`[Kim API ${operation}] ${message}`, { cause: error });
    }
    return new Error(`[Kim API ${operation}] ${message}`);
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
