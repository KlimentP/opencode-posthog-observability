const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|authorization|cookie|api[_-]?key|bearer|credential|private[_-]?key|access[_-]?key|auth)/i;

const SENSITIVE_VALUE_PATTERN = /sk-[A-Za-z0-9_-]{20,}|ph[cx]_[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]+|bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

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

  if (typeof value === "string") {
    const redacted = value.replace(SENSITIVE_VALUE_PATTERN, (match) =>
      /^\s*bearer\s+/i.test(match) ? "Bearer [Redacted]" : "[Redacted]",
    );
    if (redacted !== value) return redacted;
  }

  return value;
}
