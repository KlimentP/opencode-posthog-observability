import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";

test("loads config from project .opencode jsonc and applies env overrides", () => {
  const dir = join(tmpdir(), `opencode-posthog-${Date.now()}`);
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(
    join(dir, ".opencode", "posthog-observability.jsonc"),
    `{
      // comments are allowed
      "projectToken": "from-file",
      "captureInputs": false,
      "tags": { "env": "test" }
    }`,
  );

  try {
    const config = loadConfig(
      {
        OPENCODE_POSTHOG_PROJECT_TOKEN: "from-env",
        OPENCODE_POSTHOG_CAPTURE_OUTPUTS: "false",
        OPENCODE_POSTHOG_TAGS: "team=ai,local",
      },
      dir,
    );

    assert.equal(config.projectToken, "from-env");
    assert.equal(config.captureInputs, false);
    assert.equal(config.captureOutputs, false);
    assert.deepEqual(config.tags, { team: "ai", local: "true" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
