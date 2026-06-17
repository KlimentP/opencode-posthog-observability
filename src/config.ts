import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import stripJsonComments from "strip-json-comments";

export type PluginConfig = {
  projectToken: string;
  host: string;
  distinctId: string;
  agentName?: string;
  projectName?: string;
  captureInputs: boolean;
  captureOutputs: boolean;
  captureMetadata: boolean;
  maxTextLength: number;
  diagnostics: boolean;
  flushTimeoutMs: number;
  tags: Record<string, string>;
};

export type PartialPluginConfig = Partial<PluginConfig> & {
  projectToken?: string;
};

const DEFAULT_CONFIG: PluginConfig = {
  projectToken: "",
  host: "https://us.i.posthog.com",
  distinctId: "opencode",
  captureInputs: true,
  captureOutputs: true,
  captureMetadata: true,
  maxTextLength: 12_000,
  diagnostics: false,
  flushTimeoutMs: 5_000,
  tags: {},
};

const CONFIG_FILE_NAMES = [
  "posthog-observability.json",
  "posthog-observability.jsonc",
  "opencode-posthog-observability.json",
  "opencode-posthog-observability.jsonc",
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): PluginConfig {
  const config = mergeConfig(DEFAULT_CONFIG, loadConfigFile(env, cwd));

  const projectToken = env.OPENCODE_POSTHOG_PROJECT_TOKEN ?? env.POSTHOG_PROJECT_TOKEN;
  if (projectToken) config.projectToken = projectToken;

  if (env.OPENCODE_POSTHOG_HOST) config.host = env.OPENCODE_POSTHOG_HOST;
  if (env.OPENCODE_POSTHOG_DISTINCT_ID) config.distinctId = env.OPENCODE_POSTHOG_DISTINCT_ID;
  if (env.OPENCODE_POSTHOG_AGENT_NAME) config.agentName = env.OPENCODE_POSTHOG_AGENT_NAME;
  if (env.OPENCODE_POSTHOG_PROJECT_NAME) config.projectName = env.OPENCODE_POSTHOG_PROJECT_NAME;
  if (env.OPENCODE_POSTHOG_CAPTURE_INPUTS) {
    config.captureInputs = parseBoolean(env.OPENCODE_POSTHOG_CAPTURE_INPUTS, config.captureInputs);
  }
  if (env.OPENCODE_POSTHOG_CAPTURE_OUTPUTS) {
    config.captureOutputs = parseBoolean(env.OPENCODE_POSTHOG_CAPTURE_OUTPUTS, config.captureOutputs);
  }
  if (env.OPENCODE_POSTHOG_CAPTURE_METADATA) {
    config.captureMetadata = parseBoolean(env.OPENCODE_POSTHOG_CAPTURE_METADATA, config.captureMetadata);
  }
  if (env.OPENCODE_POSTHOG_MAX_TEXT_LENGTH) {
    config.maxTextLength = parsePositiveInt(env.OPENCODE_POSTHOG_MAX_TEXT_LENGTH, config.maxTextLength);
  }
  if (env.OPENCODE_POSTHOG_DIAGNOSTICS) {
    config.diagnostics = parseBoolean(env.OPENCODE_POSTHOG_DIAGNOSTICS, config.diagnostics);
  }
  if (env.OPENCODE_POSTHOG_FLUSH_TIMEOUT_MS) {
    config.flushTimeoutMs = parsePositiveInt(env.OPENCODE_POSTHOG_FLUSH_TIMEOUT_MS, config.flushTimeoutMs);
  }
  if (env.OPENCODE_POSTHOG_TAGS) {
    config.tags = parseTags(env.OPENCODE_POSTHOG_TAGS);
  }

  config.maxTextLength = Math.max(0, config.maxTextLength);
  config.flushTimeoutMs = Math.max(1, config.flushTimeoutMs);
  config.tags = config.tags ?? {};

  return config;
}

export function configPaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const paths: string[] = [];

  if (env.OPENCODE_POSTHOG_CONFIG) {
    paths.push(resolve(cwd, env.OPENCODE_POSTHOG_CONFIG));
  }

  paths.push(...CONFIG_FILE_NAMES.map((name) => join(cwd, ".opencode", name)));

  for (const dir of opencodeConfigDirs(env)) {
    paths.push(...CONFIG_FILE_NAMES.map((name) => join(dir, name)));
  }

  return [...new Set(paths)];
}

export function mergeConfig(base: PluginConfig, override?: PartialPluginConfig): PluginConfig {
  if (!override) return { ...base, tags: { ...base.tags } };

  return {
    ...base,
    ...definedOnly(override),
    tags: {
      ...base.tags,
      ...(isRecord(override.tags) ? override.tags : {}),
    },
  };
}

export function mergePartialConfig(base: PluginConfig, override?: PartialPluginConfig): PluginConfig {
  return mergeConfig(base, override);
}

function loadConfigFile(env: NodeJS.ProcessEnv, cwd: string): PartialPluginConfig | undefined {
  for (const path of configPaths(env, cwd)) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`PostHog observability config must be a JSON object: ${path}`);
    }
    return parsed as PartialPluginConfig;
  }

  return undefined;
}

function opencodeConfigDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [env.OPENCODE_CONFIG_DIR];

  if (env.OPENCODE_CONFIG) {
    dirs.push(dirname(resolve(env.OPENCODE_CONFIG)));
  }

  const home = env.HOME ?? env.USERPROFILE;
  if (home) {
    dirs.push(join(home, ".config", "opencode"));
    dirs.push(join(home, ".opencode"));
  }

  if (env.XDG_CONFIG_HOME) {
    dirs.push(join(env.XDG_CONFIG_HOME, "opencode"));
  }

  return [...new Set(dirs.filter(Boolean) as string[])];
}

function parseBoolean(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseTags(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    return stringifyRecord(parsed);
  }

  return Object.fromEntries(
    trimmed
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const separator = pair.indexOf("=");
        if (separator === -1) return [pair, "true"];
        return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
      })
      .filter(([key]) => key),
  );
}

function stringifyRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
