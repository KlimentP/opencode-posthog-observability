import { PostHog } from "posthog-node";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import {
  buildGenerationProperties,
  buildToolSpanProperties,
  type SessionMetadata,
} from "./events.js";
import { loadConfig, mergeConfig, type PartialPluginConfig, type PluginConfig } from "./config.js";
import { MessageTextCache } from "./text-cache.js";

export type { PartialPluginConfig, PluginConfig } from "./config.js";

type MessageLike = {
  id?: string;
  parentID?: string;
  parentId?: string;
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
  sessionID?: string;
  sessionId?: string;
  text?: string;
  type?: string;
  callID?: string;
  callId?: string;
  tool?: string;
  state?: ToolStateLike;
  metadata?: Record<string, unknown>;
};

type SessionLike = {
  id?: string;
};

type ToolStateLike = {
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
};

type ToolTranscriptEntry = {
  sessionId: string;
  messageId: string;
  callId: string;
  toolName: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  startedAt?: number;
  finishedAt?: number;
};

type RequestMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  name?: string;
};

type PluginContext = {
  config: PluginConfig;
  posthog: PostHog;
  sessions: Map<string, SessionMetadata>;
  textCache: MessageTextCache;
  reasoningCache: MessageTextCache;
  capturedMessages: Set<string>;
  pendingMessages: Map<string, Record<string, unknown>>;
  pendingAttempts: Map<string, number>;
  messageSessions: Map<string, string>;
  messageRoles: Map<string, string>;
  messageInputs: Map<string, string>;
  messageParents: Map<string, string>;
  partTypes: Map<string, string>;
  toolTranscripts: Map<string, ToolTranscriptEntry[]>;
  sessionToolTranscripts: Map<string, ToolTranscriptEntry[]>;
  capturedToolCalls: Set<string>;
  log: (message: string) => void;
};

const MAX_PENDING_ATTEMPTS = 5;
const MAX_MESSAGE_PARENTS = 2_048;

export const PostHogObservabilityPlugin: Plugin = async (
  input: PluginInput,
  options?: PartialPluginConfig,
): Promise<Hooks> => {
  const config = mergeConfig(loadConfig(undefined, input.directory), options);
  const sessions = new Map<string, SessionMetadata>();
  const textCache = new MessageTextCache({ maxTextLength: config.maxTextLength });
  const reasoningCache = new MessageTextCache({ maxTextLength: config.maxTextLength });
  const capturedMessages = new Set<string>();
  const pendingMessages = new Map<string, Record<string, unknown>>();
  const pendingAttempts = new Map<string, number>();
  const messageSessions = new Map<string, string>();
  const messageRoles = new Map<string, string>();
  const messageInputs = new Map<string, string>();
  const messageParents = new Map<string, string>();
  const partTypes = new Map<string, string>();
  const toolTranscripts = new Map<string, ToolTranscriptEntry[]>();
  const sessionToolTranscripts = new Map<string, ToolTranscriptEntry[]>();
  const capturedToolCalls = new Set<string>();
  const log = logger(input, config);

  if (!config.projectToken) {
    log("disabled: missing OPENCODE_POSTHOG_PROJECT_TOKEN or POSTHOG_PROJECT_TOKEN");
    return {};
  }

  const posthog = new PostHog(config.projectToken, { host: config.host });
  log(`enabled: ${config.host}`);

  const context: PluginContext = {
    config,
    posthog,
    sessions,
    textCache,
    reasoningCache,
    capturedMessages,
    pendingMessages,
    pendingAttempts,
    messageSessions,
    messageRoles,
    messageInputs,
    messageParents,
    partTypes,
    toolTranscripts,
    sessionToolTranscripts,
    capturedToolCalls,
    log,
  };

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
          if (existing && input) {
            existing.input = input;
            log(`params input_roles=${inputRoles(input).join(">")}`);
          }
        }
      }
    },

    async event({ event }) {
      try {
        await handleEvent(event, context);
      } catch (error) {
        log(`hook error: ${formatError(error)}`);
      }
    },

    async dispose() {
      capturePendingMessages(context);
      await posthog._shutdown(config.flushTimeoutMs);
    },
  };
};

export default PostHogObservabilityPlugin;

async function handleEvent(envelope: Event, context: PluginContext): Promise<void> {
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
      if (part.type === "tool") {
        captureToolPart(part, properties, context);
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
    if (messageId) removeMessageState(context, messageId);
    return;
  }

  if (type === "message.updated") {
    rememberMessage(properties, context);
    return;
  }

  if (type === "session.deleted" || type === "session.idle" || type === "session.error") {
    const sessionId = getSession(properties)?.id ?? getString(properties, "sessionID", "sessionId");
    capturePendingMessages(context, sessionId);
    if (sessionId && type === "session.deleted") removeSessionState(context, sessionId);
    await context.posthog.flush();
  }
}

function rememberMessage(properties: Record<string, unknown>, context: PluginContext): void {
  const message = getMessage(properties);
  if (!message?.id) return;

  const sessionId = message.sessionID ?? message.sessionId ?? getString(properties, "sessionID", "sessionId");
  if (!sessionId) return;

  context.messageSessions.set(message.id, sessionId);
  if (message.role) context.messageRoles.set(message.id, message.role);
  const parentId = message.parentID ?? message.parentId;
  if (parentId) rememberMessageParent(context, message.id, parentId);

  if (message.role === "user") {
    rememberInputFromTextCache(message.id, context);
    return;
  }

  if (message.role && message.role !== "assistant") return;
  if (!isMessageComplete(message)) return;
  const input = inputForAssistant(message, context);
  if (input) context.messageInputs.set(message.id, input);
  context.pendingMessages.set(message.id, properties);
  context.pendingAttempts.delete(message.id);
}

function capturePendingMessages(context: PluginContext, sessionId?: string): void {
  for (const [messageId, properties] of context.pendingMessages) {
    const messageSessionId = context.messageSessions.get(messageId);
    if (sessionId && messageSessionId !== sessionId) continue;
    const captured = captureMessage(properties, context);
    if (captured) {
      context.pendingAttempts.delete(messageId);
      continue;
    }
    const attempts = (context.pendingAttempts.get(messageId) ?? 0) + 1;
    context.pendingAttempts.set(messageId, attempts);
    if (attempts >= MAX_PENDING_ATTEMPTS) {
      removeMessageState(context, messageId);
      context.log(`dropped pending message ${messageId} after ${attempts} failed capture attempts`);
    }
  }
}

function captureToolPart(
  part: PartLike,
  properties: Record<string, unknown>,
  context: PluginContext,
): void {
  const state = part.state;
  if (!part.id || !state?.status) return;
  if (state.status !== "completed" && state.status !== "error") return;

  const sessionId = part.sessionID ?? part.sessionId ?? getString(properties, "sessionID", "sessionId");
  const messageId = part.messageID ?? part.messageId ?? getString(properties, "messageID", "messageId");
  const toolName = part.tool;
  if (!sessionId || !messageId || !toolName) return;

  const spanId = part.callID ?? part.callId ?? part.id;
  const captureKey = `${messageId}:${spanId}`;
  const traceId = traceIdForMessageId(messageId, context);
  const transcriptEntry = {
    sessionId,
    messageId,
    callId: spanId,
    toolName,
    status: state.status,
    input: state.input,
    output: state.output,
    error: state.error,
    startedAt: state.time?.start,
    finishedAt: state.time?.end,
  };
  rememberToolTranscript(context.toolTranscripts, transcriptEntry);
  rememberToolTranscript(context.sessionToolTranscripts, transcriptEntry, sessionId);
  if (context.capturedToolCalls.has(captureKey)) return;

  context.posthog.capture({
    distinctId: context.config.distinctId,
    event: "$ai_span",
    properties: buildToolSpanProperties({
      sessionId,
      messageId,
      spanId,
      traceId,
      parentId: traceId,
      toolName,
      status: state.status,
      input: state.input,
      output: state.output,
      error: state.error,
      metadata: {
        ...(part.metadata ? { part: part.metadata } : {}),
        ...(state.metadata ? { state: state.metadata } : {}),
        ...(state.title ? { title: state.title } : {}),
      },
      startedAt: state.time?.start,
      finishedAt: state.time?.end,
    }, context.config),
  });
  rememberCapturedMessage(context.capturedToolCalls, captureKey);
  context.log(`captured tool ${toolName} ${spanId} status=${state.status}`);
  context.log(`tool trace=${traceId} parent=${traceId} span=${spanId}`);
}

function captureMessage(properties: Record<string, unknown>, context: PluginContext): boolean {
  const message = getMessage(properties);
  if (!message?.id) return false;
  if (message.role && message.role !== "assistant") return false;
  if (!isMessageComplete(message)) return false;
  if (!context.textCache.get(message.id)) return false;
  if (context.capturedMessages.has(message.id)) return false;

  const sessionId = message.sessionID ?? message.sessionId ?? getString(properties, "sessionID", "sessionId");
  if (!sessionId) return false;

  const output = context.textCache.get(message.id);
  const reasoning = context.reasoningCache.get(message.id);
  const toolTranscript = toolTranscriptForSession(sessionId, context);
  const traceId = traceIdForMessage(message, context);
  const usage = getUsage(message);
  const input = context.messageInputs.get(message.id) ?? inputForAssistant(message, context) ?? context.sessions.get(sessionId)?.input;
  const session = {
    ...context.sessions.get(sessionId),
    model: context.sessions.get(sessionId)?.model ?? message.modelID,
    provider: context.sessions.get(sessionId)?.provider ?? message.providerID,
    input: inputWithToolTranscript(input, toolTranscript),
    spanName: spanName(message),
  };
  const eventProperties = buildGenerationProperties({
    sessionId,
    messageId: message.id,
    traceId,
    parentId: traceId === message.id ? undefined : traceId,
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
  context.pendingAttempts.delete(message.id);
  context.log(
    `captured message ${message.id} input=${textLength(session.input)} output=${output?.length ?? 0} reasoning=${reasoning?.length ?? 0} tools=${toolTranscript.length}`,
  );
  context.log(`message input_roles=${inputRoles(session.input).join(">")}`);
  context.log(`message trace=${traceId} parent=${traceId === message.id ? "" : traceId} span=${message.id}`);

  cleanupMessageAfterCapture(context, message.id, sessionId);
  return true;
}

function cleanupMessageAfterCapture(context: PluginContext, messageId: string, sessionId: string): void {
  context.textCache.removeMessage(messageId);
  context.reasoningCache.removeMessage(messageId);
  context.messageSessions.delete(messageId);
  context.messageRoles.delete(messageId);
  context.messageInputs.delete(messageId);
  context.toolTranscripts.delete(messageId);
  removeMessagePartTypes(context.partTypes, messageId);
  context.sessionToolTranscripts.delete(sessionId);
}

function removeMessageState(context: PluginContext, messageId: string): void {
  context.textCache.removeMessage(messageId);
  context.reasoningCache.removeMessage(messageId);
  context.capturedMessages.delete(messageId);
  context.pendingMessages.delete(messageId);
  context.pendingAttempts.delete(messageId);
  context.messageSessions.delete(messageId);
  context.messageRoles.delete(messageId);
  context.messageInputs.delete(messageId);
  context.messageParents.delete(messageId);
  context.toolTranscripts.delete(messageId);
  removeMessagePartTypes(context.partTypes, messageId);
  removeSessionToolTranscripts(context.sessionToolTranscripts, messageId);
  removeCapturedToolCalls(context.capturedToolCalls, messageId);
}

function removeSessionState(context: PluginContext, sessionId: string): void {
  context.sessions.delete(sessionId);
  context.sessionToolTranscripts.delete(sessionId);
  for (const [messageId, messageSessionId] of context.messageSessions) {
    if (messageSessionId === sessionId) removeMessageState(context, messageId);
  }
}

function rememberToolTranscript(
  toolTranscripts: Map<string, ToolTranscriptEntry[]>,
  entry: ToolTranscriptEntry,
  key = entry.messageId,
): void {
  const existing = toolTranscripts.get(key) ?? [];
  const index = existing.findIndex((item) => item.callId === entry.callId);
  const next = index === -1 ? [...existing, entry] : existing.map((item, itemIndex) => itemIndex === index ? entry : item);
  next.sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  toolTranscripts.set(key, next);
}

function traceIdForMessage(message: MessageLike, context: PluginContext): string | undefined {
  return message.id ? traceIdForMessageId(message.id, context) : undefined;
}

function traceIdForMessageId(messageId: string, context: PluginContext): string {
  const visited = new Set<string>();
  let current = messageId;

  while (!visited.has(current)) {
    visited.add(current);
    const parentId = context.messageParents.get(current);
    if (!parentId) return current;
    current = parentId;
  }

  return messageId;
}

function toolTranscriptForSession(
  sessionId: string,
  context: PluginContext,
): ToolTranscriptEntry[] {
  return [...(context.sessionToolTranscripts.get(sessionId) ?? [])].sort(
    (left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0),
  );
}

function inputWithToolTranscript(input: unknown, toolTranscript: ToolTranscriptEntry[]): unknown {
  if (toolTranscript.length === 0) return input;
  if (Array.isArray(input) && input.some((item) => messageRole(item) === "tool")) return input;

  const messages = Array.isArray(input)
    ? [...input]
    : input === undefined
      ? []
      : [{ role: "user", content: input }];

  for (const tool of toolTranscript) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "function",
          function: {
            name: tool.toolName,
            arguments: tool.input,
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: tool.callId,
      name: tool.toolName,
      content: contentToString(tool.status === "error" ? tool.error : tool.output),
    });
  }

  return messages;
}

function messageRole(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : undefined;
}

function spanName(message: MessageLike): string {
  const label = message.mode ?? message.agent;
  return label ? `opencode generation (${label})` : "opencode generation";
}

function inputForAssistant(message: MessageLike, context: PluginContext): string | undefined {
  const parentId = message.parentID ?? message.parentId;
  if (!parentId) return undefined;
  return context.textCache.get(parentId);
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

function extractInputFromRequestBody(body: unknown): RequestMessage[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return undefined;

  const normalized = messages
    .map((item) => normalizeRequestMessage(item))
    .filter((item): item is RequestMessage => Boolean(item));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequestMessage(message: unknown): RequestMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;
  if (!role) return undefined;

  const normalized: RequestMessage = {
    role,
    content: normalizeRequestContent(record.content),
  };

  const toolCallId = getFirstString(record, "tool_call_id", "toolCallId", "toolCallID");
  if (toolCallId) normalized.tool_call_id = toolCallId;

  const name = getFirstString(record, "name", "toolName", "tool_name");
  if (name) normalized.name = name;

  return normalized;
}

function normalizeRequestContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const normalized = content.map((item) => normalizeRequestContentPart(item));
  return normalized.length > 0 ? normalized : content;
}

function normalizeRequestContentPart(part: unknown): unknown {
  if (typeof part !== "object" || part === null) return part;
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;

  if (type === "tool-call" || type === "tool_call") {
    return {
      type: "function",
      function: {
        name: getFirstString(record, "toolName", "tool_name", "name") ?? "tool",
        arguments: record.input ?? record.args ?? record.arguments,
      },
    };
  }

  if (type === "tool-result" || type === "tool_result") {
    return {
      type: "text",
      text: contentToString(record.output ?? record.result ?? record.content),
    };
  }

  return part;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function rememberInputFromTextCache(messageId: string, context: PluginContext): void {
  if (context.messageRoles.get(messageId) !== "user") return;
  const sessionId = context.messageSessions.get(messageId);
  if (!sessionId) return;
  const input = context.textCache.get(messageId);
  if (!input) return;
  const existing = context.sessions.get(sessionId) ?? {};
  if (Array.isArray(existing.input)) return;
  context.sessions.set(sessionId, {
    ...existing,
    input,
  });
}

function rememberMessageParent(context: PluginContext, messageId: string, parentId: string): void {
  context.messageParents.set(messageId, parentId);
  while (context.messageParents.size > MAX_MESSAGE_PARENTS) {
    const oldest = context.messageParents.keys().next().value as string | undefined;
    if (!oldest) return;
    context.messageParents.delete(oldest);
  }
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

function removeCapturedToolCalls(capturedToolCalls: Set<string>, messageId: string): void {
  const prefix = `${messageId}:`;
  for (const key of capturedToolCalls.keys()) {
    if (key.startsWith(prefix)) capturedToolCalls.delete(key);
  }
}

function removeSessionToolTranscripts(sessionToolTranscripts: Map<string, ToolTranscriptEntry[]>, messageId: string): void {
  for (const [sessionId, entries] of sessionToolTranscripts) {
    const next = entries.filter((entry) => entry.messageId !== messageId);
    if (next.length === 0) {
      sessionToolTranscripts.delete(sessionId);
    } else if (next.length !== entries.length) {
      sessionToolTranscripts.set(sessionId, next);
    }
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

function inputRoles(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item !== "object" || item === null) return undefined;
      const role = (item as Record<string, unknown>).role;
      return typeof role === "string" ? role : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}