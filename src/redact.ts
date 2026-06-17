const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|authorization|cookie|api[_-]?key|bearer)/i;

export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>());
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => redactInner(item, seen));
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[Redacted]" : redactInner(item, seen),
      ]),
    );
  }

  if (typeof value === "string" && /bearer\s+[a-z0-9._~+/-]+=*/i.test(value)) {
    return value.replace(/bearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [Redacted]");
  }

  return value;
}
