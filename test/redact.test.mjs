import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../dist/redact.js";
import { buildToolSpanProperties } from "../dist/events.js";

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

test("redacts sensitive keys regardless of nesting depth", () => {
  const input = {
    apiKey: "abc",
    nested: { authorization: "Bearer xyz", safe: "ok" },
    list: [{ password: "p", other: "v" }],
  };

  assert.deepEqual(redact(input), {
    apiKey: "[Redacted]",
    nested: { authorization: "[Redacted]", safe: "ok" },
    list: [{ password: "[Redacted]", other: "v" }],
  });
});

test("redacts secret token patterns embedded in string values", () => {
  const fixtures = [
    ["sk-abcdefghijklmnopqrstuvwxyz1234567890", "[Redacted]"],
    ["phc_" + "a".repeat(24), "[Redacted]"],
    ["phx_" + "a".repeat(24), "[Redacted]"],
    ["AKIA" + "A".repeat(16), "[Redacted]"],
    ["ghp_" + "a".repeat(36), "[Redacted]"],
    ["Bearer abc123def456==", "Bearer [Redacted]"],
    ["token: ghp_" + "a".repeat(36) + " tail", "token: [Redacted] tail"],
  ];

  for (const [input, expected] of fixtures) {
    assert.equal(redact(input), expected, `expected redaction for ${input}`);
  }
});

test("leaves unrelated strings untouched", () => {
  assert.equal(redact("a normal string"), "a normal string");
  assert.equal(redact("sk-short"), "sk-short");
});

test("breaks circular references", () => {
  const obj = { name: "loop" };
  obj.self = obj;

  const redacted = redact(obj);
  assert.deepEqual(redacted, { name: "loop", self: "[Circular]" });
});

test("truncates oversized tool payloads via buildToolSpanProperties", () => {
  const smallConfig = { ...config, maxTextLength: 32 };
  const oversized = "x".repeat(1000);

  const properties = buildToolSpanProperties(
    {
      sessionId: "session-1",
      messageId: "message-1",
      spanId: "tool-call-1",
      toolName: "bash",
      status: "completed",
      input: { command: oversized },
      output: oversized,
      error: { message: oversized },
    },
    smallConfig,
  );

  const marker = "...[truncated]";

  assert.equal(typeof properties.$ai_input_state, "string");
  assert.ok(properties.$ai_input_state.endsWith(marker));
  assert.ok((properties.$ai_input_state).length <= smallConfig.maxTextLength + marker.length);

  assert.equal(typeof properties.$ai_output_state, "string");
  assert.ok(properties.$ai_output_state.endsWith(marker));

  assert.equal(typeof properties.$ai_error, "string");
  assert.ok(properties.$ai_error.endsWith(marker));
});

test("does not truncate tool payloads within size budget", () => {
  const properties = buildToolSpanProperties(
    {
      sessionId: "session-1",
      messageId: "message-1",
      spanId: "tool-call-1",
      toolName: "bash",
      status: "completed",
      input: { command: "ls" },
      output: "src\n",
    },
    config,
  );

  assert.deepEqual(properties.$ai_input_state, { command: "ls" });
  assert.equal(properties.$ai_output_state, "src\n");
});