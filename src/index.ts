import { PostHog } from "posthog-node";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { buildGenerationProperties, type SessionMetadata } from "./events.js";
import { loadConfig, mergePartialConfig, type PartialPluginConfig, type PluginConfig } from "./config.js";
import { MessageTextCache } from "./text-cache.js";

export type { PartialPluginConfig, PluginConfig } from "./config.js";

type MessageLike = {
  id?: string;
  sessionID?: string;
  sessionId?: string;
  role?: string;
  agent?: string;
  mode?: string;
  time?: { completed?: number; created?: number };
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  usage?: { input?: number; output?: number; input_tokens?: number; output_tokens?: number };
  modelID?: string;
  providerID?: string;
};

type PartLike = {
  id?: string;
  messageID?: string;
  messageId?: string;
  text?: string;
  type?: string;
};

type SessionLike = {
  id?: string;
};

export const PostHogObservabilityPlugin: Plugin = async (
  input: PluginInput,
  options?: PartialPluginConfig,
): Promise<Hooks> => {
  const config = mergePartialConfig(loadConfig(undefined, input.directory), options);
  const sessions = new Map<string, SessionMetadata>();
  const textCache = new MessageTextCache({ maxTextLength: config.maxTextLength });
  const reasoningCache = new MessageTextCache({ maxTextLength: config.maxTextLength });
  const capturedMessages = new Set<string>();
  const pendingMessages = new Map<string, Record<string, unknown>>();
  const messageSessions = new Map<string, string>();
  const messageRoles = new Map<string, string>();
  const partTypes = new Map<string, string>();
  let posthog: PostHog | undefined;

  const log = logger(input, config);

  if (!config.projectToken) {
    log("disabled: missing OPENCODE_POSTHOG_PROJECT_TOKEN or POSTHOG_PROJECT_TOKEN");
    return {};
  }

  posthog = new PostHog(config.projectToken, { host: config.host });
  log(`enabled: ${config.host}`);

  return {
    async "chat.params"(chatInput, output) {
      const existing = sessions.get(chatInput.sessionID);
      sessions.set(chatInput.sessionID, {
        ...existing,
        model: getModelId(chatInput.model),
        provider: getProviderId(chatInput.provider),
        startedAt: Date.now(),
      });

      if (output.options && typeof output.options === "object") {
        const extraBody = (output.options as { body?: unknown }).body;
        if (extraBody !== undefined) {
          const existing = sessions.get(chatInput.sessionID);
          const input = extractInputFromRequestBody(extraBody);
          if (existing && input) existing.input = input;
        }
      }
    },

    async event({ event }) {
      try {
        await handleEvent(event, {
          config,
          posthog: posthog!,
          sessions,
          textCache,
          reasoningCache,
          capturedMessages,
          pendingMessages,
          messageSessions,
          messageRoles,
          partTypes,
          log,
        });
      } catch (error) {
        log(`hook error: ${formatError(error)}`);
      }
    },

    async dispose() {
      capturePendingMessages({
        config,
        posthog: posthog!,
        sessions,
        textCache,
        reasoningCache,
        capturedMessages,
        pendingMessages,
        messageSessions,
        messageRoles,
        partTypes,
        log,
      });
      await posthog?._shutdown(config.flushTimeoutMs);
    },
  };
};

export default PostHogObservabilityPlugin;

async function handleEvent(
  envelope: Event,
  context: {
    config: PluginConfig;
    posthog: PostHog;
    sessions: Map<string, SessionMetadata>;
    textCache: MessageTextCache;
    reasoningCache: MessageTextCache;
    capturedMessages: Set<string>;
    pendingMessages: Map<string, Record<string, unknown>>;
    messageSessions: Map<string, string>;
    messageRoles: Map<string, string>;
    partTypes: Map<string, string>;
    log: (message: string) => void;
  },
): Promise<void> {
  const type = String(envelope.type);
  const properties = (envelope as { properties?: unknown }).properties as Record<string, unknown> | undefined;
  if (!properties) return;

  if (type === "message.part.updated") {
    const part = properties.part as PartLike | undefined;
    const messageId = part?.messageID ?? part?.messageId ?? getString(properties, "messageID", "messageId");
    if (messageId && part?.id) {
      if (part.type) context.partTypes.set(partKey(messageId, part.id), part.type);
      if (part.type === "text" && typeof part.text === "string") {
        context.textCache.update(messageId, part.id, part.text);
        rememberInputFromTextCache(messageId, context);
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        context.reasoningCache.update(messageId, part.id, part.text);
      }
    }
    return;
  }

  if (type === "message.part.delta") {
    const messageId = getString(properties, "messageID", "messageId");
    const partId = getString(properties, "partID", "partId");
    const delta = typeof properties.delta === "string" ? properties.delta : undefined;
    const field = typeof properties.field === "string" ? properties.field : "text";
    if (messageId && partId && delta && field === "text") {
      const partType = context.partTypes.get(partKey(messageId, partId));
      if (partType === "text") {
        context.textCache.append(messageId, partId, delta);
        rememberInputFromTextCache(messageId, context);
      }
      if (partType === "reasoning") {
        context.reasoningCache.append(messageId, partId, delta);
      }
    }
    return;
  }

  if (type === "session.next.text.delta") {
    const messageId = getString(properties, "assistantMessageID", "assistantMessageId");
    const partId = getString(properties, "textID", "textId");
    const delta = typeof properties.delta === "string" ? properties.delta : undefined;
    if (messageId && partId && delta) {
      context.textCache.append(messageId, partId, delta);
    }
    return;
  }

  if (type === "session.next.reasoning.delta") {
    const messageId = getString(properties, "assistantMessageID", "assistantMessageId");
    const partId = getString(properties, "reasoningID", "reasoningId");
    const delta = typeof properties.delta === "string" ? properties.delta : undefined;
    if (messageId && partId && delta) {
      context.reasoningCache.append(messageId, partId, delta);
    }
    return;
  }

  if (type === "message.part.removed") {
    const part = properties.part as PartLike | undefined;
    const messageId = part?.messageID ?? part?.messageId ?? getString(properties, "messageID", "messageId");
    const partId = part?.id ?? getString(properties, "partID", "partId");
    if (messageId && partId) {
      context.textCache.removePart(messageId, partId);
      context.partTypes.delete(partKey(messageId, partId));
    }
    return;
  }

  if (type === "message.removed") {
    const messageId = getMessage(properties)?.id ?? getString(properties, "messageID", "messageId");
    if (messageId) {
      context.textCache.removeMessage(messageId);
      context.reasoningCache.removeMessage(messageId);
      context.capturedMessages.delete(messageId);
      context.pendingMessages.delete(messageId);
      context.messageSessions.delete(messageId);
      context.messageRoles.delete(messageId);
      removeMessagePartTypes(context.partTypes, messageId);
    }
    return;
  }

  if (type === "message.updated") {
    rememberMessage(properties, context);
    return;
  }

  if (type === "session.deleted" || type === "session.idle" || type === "session.error") {
    const sessionId = getSession(properties)?.id ?? getString(properties, "sessionID", "sessionId");
    capturePendingMessages(context, sessionId);
    if (sessionId && type === "session.deleted") context.sessions.delete(sessionId);
    await context.posthog.flush();
  }
}

function rememberMessage(
  properties: Record<string, unknown>,
  context: {
    sessions: Map<string, SessionMetadata>;
    textCache: MessageTextCache;
    pendingMessages: Map<string, Record<string, unknown>>;
    messageSessions: Map<string, string>;
    messageRoles: Map<string, string>;
  },
): void {
  const message = getMessage(properties);
  if (!message?.id) return;

  const sessionId = message.sessionID ?? message.sessionId ?? getString(properties, "sessionID", "sessionId");
  if (!sessionId) return;

  context.messageSessions.set(message.id, sessionId);
  if (message.role) context.messageRoles.set(message.id, message.role);

  if (message.role === "user") {
    rememberInputFromTextCache(message.id, context);
    return;
  }

  if (message.role && message.role !== "assistant") return;
  if (!isMessageComplete(message)) return;
  context.pendingMessages.set(message.id, properties);
}

function capturePendingMessages(
  context: {
    config: PluginConfig;
    posthog: PostHog;
    sessions: Map<string, SessionMetadata>;
    textCache: MessageTextCache;
    reasoningCache: MessageTextCache;
    capturedMessages: Set<string>;
    pendingMessages: Map<string, Record<string, unknown>>;
    messageSessions: Map<string, string>;
    messageRoles: Map<string, string>;
    partTypes: Map<string, string>;
    log: (message: string) => void;
  },
  sessionId?: string,
): void {
  for (const [messageId, properties] of context.pendingMessages) {
    const messageSessionId = context.messageSessions.get(messageId);
    if (sessionId && messageSessionId !== sessionId) continue;
    captureMessage(properties, context);
  }
}

function captureMessage(
  properties: Record<string, unknown>,
  context: {
    config: PluginConfig;
    posthog: PostHog;
    sessions: Map<string, SessionMetadata>;
    textCache: MessageTextCache;
    reasoningCache: MessageTextCache;
    capturedMessages: Set<string>;
    pendingMessages: Map<string, Record<string, unknown>>;
    log: (message: string) => void;
  },
): void {
  const message = getMessage(properties);
  if (!message?.id) return;
  if (message.role && message.role !== "assistant") return;
  if (!isMessageComplete(message)) return;
  if (!context.textCache.get(message.id)) return;
  if (context.capturedMessages.has(message.id)) return;

  const sessionId = message.sessionID ?? message.sessionId ?? getString(properties, "sessionID", "sessionId");
  if (!sessionId) return;

  const output = context.textCache.get(message.id);
  const reasoning = context.reasoningCache.get(message.id);
  const usage = getUsage(message);
  const session = {
    ...context.sessions.get(sessionId),
    model: context.sessions.get(sessionId)?.model ?? message.modelID,
    provider: context.sessions.get(sessionId)?.provider ?? message.providerID,
    spanName: spanName(message),
  };
  const eventProperties = buildGenerationProperties({
    sessionId,
    messageId: message.id,
    output,
    reasoning,
    usage,
    session,
    metadata: properties,
    finishedAt: message.time?.completed,
  }, context.config);

  context.posthog.capture({
    distinctId: context.config.distinctId,
    event: "$ai_generation",
    properties: eventProperties,
  });
  rememberCapturedMessage(context.capturedMessages, message.id);
  context.pendingMessages.delete(message.id);
  context.log(
    `captured message ${message.id} input=${textLength(session.input)} output=${output?.length ?? 0} reasoning=${reasoning?.length ?? 0}`,
  );
}

function spanName(message: MessageLike): string {
  const label = message.mode ?? message.agent;
  return label ? `opencode generation (${label})` : "opencode generation";
}

function getMessage(properties: Record<string, unknown>): MessageLike | undefined {
  const message = properties.message ?? properties.info;
  return typeof message === "object" && message !== null ? (message as MessageLike) : undefined;
}

function getSession(properties: Record<string, unknown>): SessionLike | undefined {
  const session = properties.session ?? properties.info;
  return typeof session === "object" && session !== null ? (session as SessionLike) : undefined;
}

function isMessageComplete(message: MessageLike): boolean {
  return typeof message.time?.completed === "number";
}

function getUsage(message: MessageLike): { input?: number; output?: number } {
  return {
    input: message.tokens?.input ?? message.usage?.input ?? message.usage?.input_tokens,
    output: message.tokens?.output ?? message.usage?.output ?? message.usage?.output_tokens,
  };
}

function getModelId(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null) {
    const record = model as Record<string, unknown>;
    return getFirstString(record, "id", "modelID", "modelId");
  }
  return undefined;
}

function getProviderId(provider: unknown): string | undefined {
  if (typeof provider === "string") return provider;
  if (typeof provider === "object" && provider !== null) {
    const record = provider as Record<string, unknown>;
    const info = record.info;
    if (typeof info === "object" && info !== null) {
      const id = getFirstString(info as Record<string, unknown>, "id", "providerID", "providerId");
      if (id) return id;
    }
    return getFirstString(record, "id", "providerID", "providerId");
  }
  return undefined;
}

function getFirstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractInputFromRequestBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.role !== "user") continue;
    return contentToString(record.content);
  }

  return undefined;
}

function contentToString(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item))
    .join("\n");

  return text || undefined;
}

function rememberInputFromTextCache(
  messageId: string,
  context: {
    sessions: Map<string, SessionMetadata>;
    textCache: MessageTextCache;
    messageSessions: Map<string, string>;
    messageRoles: Map<string, string>;
  },
): void {
  if (context.messageRoles.get(messageId) !== "user") return;
  const sessionId = context.messageSessions.get(messageId);
  if (!sessionId) return;
  const input = context.textCache.get(messageId);
  if (!input) return;
  const existing = context.sessions.get(sessionId) ?? {};
  context.sessions.set(sessionId, {
    ...existing,
    input,
  });
}

function getString(properties: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function logger(input: PluginInput, config: PluginConfig): (message: string) => void {
  return (message: string) => {
    if (!config.diagnostics) return;
    const app = (input.client as { app?: { log?: (message: unknown) => unknown } }).app;
    const appLog = app?.log?.bind(app);
    if (appLog) {
      Promise.resolve(
        appLog({
          body: {
            service: "opencode-posthog-observability",
            level: "debug",
            message,
          },
        }),
      ).catch(() => undefined);
      return;
    }
    console.error(`[posthog-observability] ${message}`);
  };
}

function rememberCapturedMessage(capturedMessages: Set<string>, messageId: string): void {
  capturedMessages.add(messageId);
  while (capturedMessages.size > 2_048) {
    const oldest = capturedMessages.values().next().value as string | undefined;
    if (!oldest) return;
    capturedMessages.delete(oldest);
  }
}

function partKey(messageId: string, partId: string): string {
  return `${messageId}:${partId}`;
}

function removeMessagePartTypes(partTypes: Map<string, string>, messageId: string): void {
  const prefix = `${messageId}:`;
  for (const key of partTypes.keys()) {
    if (key.startsWith(prefix)) partTypes.delete(key);
  }
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
