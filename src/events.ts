import type { PluginConfig } from "./config.js";
import { redact } from "./redact.js";

export type SessionMetadata = {
  model?: string;
  provider?: string;
  input?: unknown;
  startedAt?: number;
};

export type GenerationInput = {
  sessionId: string;
  messageId: string;
  output?: string;
  usage?: {
    input?: number;
    output?: number;
  };
  session?: SessionMetadata;
  metadata?: Record<string, unknown>;
  finishedAt?: number;
};

export function buildGenerationProperties(input: GenerationInput, config: PluginConfig): Record<string, unknown> {
  const startedAt = input.session?.startedAt;
  const finishedAt = input.finishedAt ?? Date.now();
  const latency = typeof startedAt === "number" && finishedAt >= startedAt ? (finishedAt - startedAt) / 1000 : undefined;

  const properties: Record<string, unknown> = {
    $ai_trace_id: input.sessionId,
    $ai_session_id: input.sessionId,
    $ai_span_id: input.messageId,
    $ai_span_name: "opencode generation",
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
    properties.$ai_input = redact(input.session.input);
  }

  if (config.captureOutputs && input.output) {
    properties.$ai_output_choices = [{ content: input.output, role: "assistant" }];
  }

  if (config.captureMetadata && input.metadata) {
    properties.opencode_metadata = redact(input.metadata);
  }

  return dropUndefined(properties);
}

function prefixTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [`tag_${key}`, value]));
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
