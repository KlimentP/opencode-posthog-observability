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
  const capturedMessages = new Set<string>();
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
      sessions.set(chatInput.sessionID, {
        model: chatInput.model.id,
        provider: chatInput.provider.info.id,
        input: chatInput.message,
        startedAt: Date.now(),
      });

      if (output.options && typeof output.options === "object") {
        const extraBody = (output.options as { body?: unknown }).body;
        if (extraBody !== undefined) {
          const existing = sessions.get(chatInput.sessionID);
          if (existing) existing.input = extraBody;
        }
      }
    },

    async event({ event }) {
      try {
        await handleEvent(event, { config, posthog: posthog!, sessions, textCache, capturedMessages, log });
      } catch (error) {
        log(`hook error: ${formatError(error)}`);
      }
    },

    async dispose() {
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
    capturedMessages: Set<string>;
    log: (message: string) => void;
  },
): Promise<void> {
  const type = envelope.type;
  const properties = (envelope as { properties?: unknown }).properties as Record<string, unknown> | undefined;
  if (!properties) return;

  if (type === "message.part.updated") {
    const part = properties.part as PartLike | undefined;
    const messageId = part?.messageID ?? part?.messageId ?? getString(properties, "messageID", "messageId");
    if (messageId && part?.id && typeof part.text === "string") {
      context.textCache.update(messageId, part.id, part.text);
    }
    return;
  }

  if (type === "message.part.removed") {
    const part = properties.part as PartLike | undefined;
    const messageId = part?.messageID ?? part?.messageId ?? getString(properties, "messageID", "messageId");
    const partId = part?.id ?? getString(properties, "partID", "partId");
    if (messageId && partId) context.textCache.removePart(messageId, partId);
    return;
  }

  if (type === "message.removed") {
    const messageId = getMessage(properties)?.id ?? getString(properties, "messageID", "messageId");
    if (messageId) {
      context.textCache.removeMessage(messageId);
      context.capturedMessages.delete(messageId);
    }
    return;
  }

  if (type === "message.updated") {
    captureMessage(properties, context);
    return;
  }

  if (type === "session.deleted" || type === "session.idle" || type === "session.error") {
    const sessionId = getSession(properties)?.id ?? getString(properties, "sessionID", "sessionId");
    if (sessionId && type === "session.deleted") context.sessions.delete(sessionId);
    await context.posthog.flush();
  }
}

function captureMessage(
  properties: Record<string, unknown>,
  context: {
    config: PluginConfig;
    posthog: PostHog;
    sessions: Map<string, SessionMetadata>;
    textCache: MessageTextCache;
    capturedMessages: Set<string>;
    log: (message: string) => void;
  },
): void {
  const message = getMessage(properties);
  if (!message?.id) return;
  if (message.role && message.role !== "assistant") return;
  if (!isMessageComplete(message)) return;
  if (context.capturedMessages.has(message.id)) return;

  const sessionId = message.sessionID ?? message.sessionId ?? getString(properties, "sessionID", "sessionId");
  if (!sessionId) return;

  const output = context.textCache.get(message.id);
  const usage = getUsage(message);
  const session = {
    ...context.sessions.get(sessionId),
    model: context.sessions.get(sessionId)?.model ?? message.modelID,
    provider: context.sessions.get(sessionId)?.provider ?? message.providerID,
  };
  const eventProperties = buildGenerationProperties({
    sessionId,
    messageId: message.id,
    output,
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
  context.log(`captured message ${message.id}`);
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
