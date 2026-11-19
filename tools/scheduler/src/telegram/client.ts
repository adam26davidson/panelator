export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; data?: string; message?: TelegramMessage };
  edited_message?: TelegramMessage;
}
export interface Keyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}
export interface SendMessage {
  text: string;
  reply_to_message_id?: number;
  reply_markup?: Keyboard;
}
export class TelegramApiError extends Error {
  error_code: number;
  description: string;
  readonly bot_api: boolean;
  constructor(error_code: number, description: string, bot_api = false) {
    super(`Telegram API ${error_code}: ${description}`);
    this.error_code = error_code;
    this.description = description;
    this.bot_api = bot_api;
  }
}
export const isAuthError = (e: unknown) =>
  e instanceof TelegramApiError &&
  e.bot_api &&
  [401, 404].includes(e.error_code);
export class TelegramClient {
  private token: string;
  readonly chatId: number;
  private baseUrl: string;
  constructor(
    token: string,
    chatId: number,
    baseUrl = "https://api.telegram.org",
  ) {
    this.token = token;
    this.chatId = chatId;
    this.baseUrl = baseUrl;
  }
  private async call<T>(
    method: string,
    body: object = {},
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new TelegramApiError(0, "connection failed");
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new TelegramApiError(response.status, "invalid response", false);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new TelegramApiError(response.status, "invalid response", false);
    const data = parsed as {
      ok?: unknown;
      result?: T;
      error_code?: unknown;
      description?: unknown;
    };
    if (!response.ok || data.ok !== true) {
      const botApi = data.ok === false && typeof data.error_code === "number";
      throw new TelegramApiError(
        botApi ? (data.error_code as number) : response.status,
        (typeof data.description === "string"
          ? data.description
          : "request failed"
        )
          .split(this.token)
          .join("[redacted]"),
        botApi,
      );
    }
    return data.result as T;
  }
  getMe(signal?: AbortSignal) {
    return this.call<{ id: number; username: string }>("getMe", {}, signal);
  }
  getUpdates(opts: {
    offset: number;
    timeout: number;
    allowed_updates?: string[];
    signal?: AbortSignal;
  }) {
    const { signal, ...body } = opts;
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { ...body, allowed_updates: ["message", "callback_query"] },
      signal,
    );
  }
  async sendMessage(message: SendMessage) {
    return (
      await this.call<TelegramMessage>("sendMessage", {
        chat_id: this.chatId,
        ...message,
      })
    ).message_id;
  }
  editMessageReplyMarkup(
    message_id: number,
    reply_markup: Keyboard = { inline_keyboard: [] },
  ) {
    return this.call("editMessageReplyMarkup", {
      chat_id: this.chatId,
      message_id,
      reply_markup,
    });
  }
  answerCallbackQuery(callback_query_id: string) {
    return this.call("answerCallbackQuery", { callback_query_id });
  }
}
