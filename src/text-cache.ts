export type MessageTextCacheOptions = {
  maxMessages?: number;
  maxTextLength: number;
};

type PartMap = Map<string, string>;

export class MessageTextCache {
  readonly #messages = new Map<string, PartMap>();
  readonly #maxMessages: number;
  readonly #maxTextLength: number;

  constructor(options: MessageTextCacheOptions) {
    this.#maxMessages = options.maxMessages ?? 500;
    this.#maxTextLength = options.maxTextLength;
  }

  update(messageId: string, partId: string, text: string): void {
    let parts = this.#messages.get(messageId);
    if (!parts) {
      parts = new Map();
      this.#messages.set(messageId, parts);
    }

    parts.set(partId, this.#truncate(text));
    this.#evictOldest();
  }

  removePart(messageId: string, partId: string): void {
    const parts = this.#messages.get(messageId);
    if (!parts) return;
    parts.delete(partId);
    if (parts.size === 0) this.#messages.delete(messageId);
  }

  removeMessage(messageId: string): void {
    this.#messages.delete(messageId);
  }

  get(messageId: string): string | undefined {
    const parts = this.#messages.get(messageId);
    if (!parts) return undefined;
    const text = [...parts.values()].join("\n");
    return text ? this.#truncate(text) : undefined;
  }

  #truncate(text: string): string {
    if (this.#maxTextLength <= 0) return "";
    if (text.length <= this.#maxTextLength) return text;
    return `${text.slice(0, this.#maxTextLength)}...[truncated]`;
  }

  #evictOldest(): void {
    while (this.#messages.size > this.#maxMessages) {
      const oldest = this.#messages.keys().next().value as string | undefined;
      if (!oldest) return;
      this.#messages.delete(oldest);
    }
  }
}
