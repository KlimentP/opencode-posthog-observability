import type { PluginConfig } from "./config.js";
import { redact } from "./redact.js";

export type SessionMetadata = {
  model?: string;
  provider?: string;
  input?: unknown;
  startedAt?: number;
  spanName?: string;
};

export type GenerationInput = {
  sessionId: string;
  messageId: string;
  output?: string;
  reasoning?: string;
  usage?: {
    input?: number;
    output?: number;
  };
  session?: SessionMetadata;
  metadata?: Record<string, unknown>;
  finishedAt?: number;
};

export type ToolSpanInput = {
  sessionId: string;
  messageId: string;
  spanId: string;
  toolName: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  startedAt?: number;
  finishedAt?: number;
};

export function buildGenerationProperties(input: GenerationInput, config: PluginConfig): Record<string, unknown> {
  const startedAt = input.session?.startedAt;
  const finishedAt = input.finishedAt ?? Date.now();
  const latency = typeof startedAt === "number" && finishedAt >= startedAt ? (finishedAt - startedAt) / 1000 : undefined;

  const properties: Record<string, unknown> = {
    $ai_trace_id: input.messageId,
    $ai_session_id: input.sessionId,
    $ai_span_id: input.messageId,
    $ai_span_name: input.session?.spanName ?? "opencode generation",
    $ai_model: input.session?.model,
    $ai_provider: input.session?.provider,
    $ai_input_tokens: input.usage?.input,
    $ai_output_tokens: input.usage?.output,
    $ai_latency: latency,
    opencode_session_id: input.sessionId,
    opencode_message_id: input.messageId,
    opencode_agent_name: config.agentName,
    opencode_project_name: config.projectName,
    ...prefixTags(config.tags),
  };

  if (config.captureInputs && input.session?.input !== undefined) {
    properties.$ai_input = normalizeInputMessages(input.session.input);
  }

  if (config.captureOutputs) {
    const outputChoices = [
      ...(input.reasoning ? [{ content: input.reasoning, role: "reasoning" }] : []),
      ...(input.output ? [{ content: input.output, role: "assistant" }] : []),
    ];
    if (outputChoices.length > 0) {
      properties.$ai_output_choices = outputChoices;
    }
  }

  if (config.captureMetadata && input.metadata) {
    properties.opencode_metadata = redact(input.metadata);
  }

  return dropUndefined(properties);
}

export function buildToolSpanProperties(input: ToolSpanInput, config: PluginConfig): Record<string, unknown> {
  const latency = typeof input.startedAt === "number" && typeof input.finishedAt === "number" && input.finishedAt >= input.startedAt
    ? (input.finishedAt - input.startedAt) / 1000
    : undefined;

  const properties: Record<string, unknown> = {
    $ai_trace_id: input.messageId,
    $ai_session_id: input.sessionId,
    $ai_span_id: input.spanId,
    $ai_span_name: `tool: ${input.toolName}`,
    $ai_parent_id: input.messageId,
    $ai_latency: latency,
    $ai_is_error: input.status === "error",
    $ai_error: input.error ? redact(input.error) : undefined,
    opencode_session_id: input.sessionId,
    opencode_message_id: input.messageId,
    opencode_tool_call_id: input.spanId,
    opencode_tool_name: input.toolName,
    opencode_tool_status: input.status,
    opencode_agent_name: config.agentName,
    opencode_project_name: config.projectName,
    ...prefixTags(config.tags),
  };

  if (config.captureInputs && input.input !== undefined) {
    properties.$ai_input_state = redact(input.input);
  }

  if (config.captureOutputs && input.output !== undefined) {
    properties.$ai_output_state = redact(input.output);
  }

  if (config.captureMetadata && input.metadata) {
    properties.opencode_metadata = redact(input.metadata);
  }

  return dropUndefined(properties);
}

function normalizeInputMessages(input: unknown): Array<{ role: string; content: unknown }> {
  const redacted = redact(input);
  if (typeof redacted === "string") {
    return [{ role: "user", content: redacted }];
  }

  if (Array.isArray(redacted)) {
    return redacted.map((item) => normalizeInputMessage(item));
  }

  return [normalizeInputMessage(redacted)];
}

function normalizeInputMessage(input: unknown): { role: string; content: unknown } {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    return {
      role: typeof record.role === "string" ? record.role : "user",
      content: record.content ?? record.text ?? record.body ?? input,
    };
  }

  return { role: "user", content: input };
}

function prefixTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [`tag_${key}`, value]));
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
