import assert from "node:assert/strict";
import test from "node:test";
import { buildGenerationProperties, buildToolSpanProperties } from "../dist/events.js";
import { MessageTextCache } from "../dist/text-cache.js";

const config = {
  projectToken: "token",
  host: "https://us.i.posthog.com",
  distinctId: "opencode",
  captureInputs: true,
  captureOutputs: true,
  captureMetadata: true,
  maxTextLength: 12_000,
  diagnostics: false,
  flushTimeoutMs: 5_000,
  tags: { env: "test" },
};

test("builds posthog ai generation properties", () => {
  const properties = buildGenerationProperties(
    {
      sessionId: "session-1",
      messageId: "message-1",
      output: "Hello",
      reasoning: "Thinking...",
      usage: { input: 12, output: 7 },
      session: {
        model: "claude-sonnet-4",
        provider: "anthropic",
        input: [{ role: "user", content: "Hi", authorization: "Bearer abc" }],
        spanName: "opencode generation (build)",
        startedAt: 1000,
      },
      metadata: { token: "secret", nested: { ok: true } },
      finishedAt: 2500,
    },
    config,
  );

  assert.equal(properties.$ai_trace_id, "message-1");
  assert.equal(properties.$ai_session_id, "session-1");
  assert.equal(properties.$ai_model, "claude-sonnet-4");
  assert.equal(properties.$ai_span_name, "opencode generation (build)");
  assert.equal(properties.$ai_latency, 1.5);
  assert.deepEqual(properties.$ai_output_choices, [
    { content: "Thinking...", role: "reasoning" },
    { content: "Hello", role: "assistant" },
  ]);
  assert.deepEqual(properties.$ai_input, [{ role: "user", content: "Hi" }]);
  assert.deepEqual(properties.opencode_metadata, { token: "[Redacted]", nested: { ok: true } });
  assert.equal(properties.tag_env, "test");
});

test("normalizes string input to posthog input messages", () => {
  const properties = buildGenerationProperties(
    {
      sessionId: "session-1",
      messageId: "message-1",
      session: {
        input: "Hello",
      },
    },
    config,
  );

  assert.deepEqual(properties.$ai_input, [{ role: "user", content: "Hello" }]);
});

test("builds posthog ai span properties for tool calls", () => {
  const properties = buildToolSpanProperties(
    {
      sessionId: "session-1",
      messageId: "message-1",
      spanId: "tool-call-1",
      toolName: "bash",
      status: "completed",
      input: { command: "ls" },
      output: "src\n",
      metadata: { authorization: "Bearer abc", title: "List files" },
      startedAt: 1000,
      finishedAt: 1750,
    },
    config,
  );

  assert.equal(properties.$ai_trace_id, "message-1");
  assert.equal(properties.$ai_session_id, "session-1");
  assert.equal(properties.$ai_span_id, "tool-call-1");
  assert.equal(properties.$ai_parent_id, "message-1");
  assert.equal(properties.$ai_span_name, "tool: bash");
  assert.equal(properties.$ai_latency, 0.75);
  assert.equal(properties.$ai_is_error, false);
  assert.deepEqual(properties.$ai_input_state, { command: "ls" });
  assert.equal(properties.$ai_output_state, "src\n");
  assert.deepEqual(properties.opencode_metadata, { authorization: "[Redacted]", title: "List files" });
  assert.equal(properties.opencode_tool_name, "bash");
  assert.equal(properties.tag_env, "test");
});

test("builds error state for failed tool calls", () => {
  const properties = buildToolSpanProperties(
    {
      sessionId: "session-1",
      messageId: "message-1",
      spanId: "tool-call-1",
      toolName: "bash",
      status: "error",
      error: { message: "nope", token: "secret" },
    },
    config,
  );

  assert.equal(properties.$ai_is_error, true);
  assert.deepEqual(properties.$ai_error, { message: "nope", token: "[Redacted]" });
});

test("message cache joins parts and truncates text", () => {
  const cache = new MessageTextCache({ maxTextLength: 5 });
  cache.update("message-1", "part-1", "Hello");
  cache.update("message-1", "part-2", " world");

  assert.equal(cache.get("message-1"), "Hello...[truncated]");

  cache.removePart("message-1", "part-1");
  assert.equal(cache.get("message-1"), " worl...[truncated]");
});

test("message cache appends streaming deltas", () => {
  const cache = new MessageTextCache({ maxTextLength: 100 });
  cache.append("message-1", "part-1", "Hel");
  cache.append("message-1", "part-1", "lo");

  assert.equal(cache.get("message-1"), "Hello");
});
