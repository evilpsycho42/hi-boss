import assert from "node:assert/strict";
import test from "node:test";
import { getProviderCliEnvOverrides, mergeProviderCliEnvOverrides } from "./provider-env.js";

test("getProviderCliEnvOverrides returns provider-specific env map", () => {
  const metadata = {
    providerCli: {
      claude: {
        env: {
          ANTHROPIC_BASE_URL: "https://example.invalid",
          ANTHROPIC_API_KEY: "secret-key",
          IGNORE_NON_STRING: 42,
        },
      },
      codex: {
        env: {
          CODEX_HOME: "/tmp/codex-home",
        },
      },
    },
  };

  const claudeEnv = getProviderCliEnvOverrides(metadata, "claude");
  const codexEnv = getProviderCliEnvOverrides(metadata, "codex");
  assert.deepEqual(claudeEnv, {
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_API_KEY: "secret-key",
  });
  assert.deepEqual(codexEnv, {
    CODEX_HOME: "/tmp/codex-home",
  });
});

test("getProviderCliEnvOverrides returns undefined for invalid shape", () => {
  assert.equal(getProviderCliEnvOverrides(undefined, "claude"), undefined);
  assert.equal(getProviderCliEnvOverrides({ providerCli: null }, "claude"), undefined);
  assert.equal(getProviderCliEnvOverrides({ providerCli: { claude: { env: [] } } }, "claude"), undefined);
});

test("mergeProviderCliEnvOverrides merges without dropping unrelated metadata", () => {
  const metadata = {
    providerCli: {
      codex: {
        env: {
          CODEX_HOME: "/tmp/old",
        },
      },
    },
  };

  const merged = mergeProviderCliEnvOverrides({
    metadata,
    provider: "claude",
    envOverrides: {
      ANTHROPIC_BASE_URL: "https://claude.example",
      ANTHROPIC_API_KEY: "abc123",
    },
  });

  assert.deepEqual(merged, {
    providerCli: {
      codex: {
        env: {
          CODEX_HOME: "/tmp/old",
        },
      },
      claude: {
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_API_KEY: "abc123",
        },
      },
    },
  });
});

