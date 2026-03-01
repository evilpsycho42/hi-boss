import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChannelCommandHandler } from "./channel-commands.js";
import { HiBossDatabase } from "./db/database.js";
import { writeAgentRunTrace } from "../shared/agent-run-trace.js";
import { INTERNAL_VERSION } from "../shared/version.js";

function withTempDb(run: (db: HiBossDatabase) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-channel-cmd-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  return Promise.resolve()
    .then(() => run(db))
    .finally(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test("/new switches current chat default session and returns old/new ids", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    const initial = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });

    const executor = {
      isAgentBusy: () => false,
      abortCurrentRun: () => false,
      invalidateChannelSessionCache: () => undefined,
    } as any;

    const handler = createChannelCommandHandler({
      db,
      executor,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "new",
      args: "",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response);
    assert.equal(typeof response?.text, "string");
    assert.equal(response?.text?.includes("session-new: ok"), true);

    const binding = db.getChannelSessionBinding("nex", "telegram", "chat-1");
    assert.ok(binding);
    assert.notEqual(binding.defaultSessionId, initial.session.id);
  });
});

test("/sessions returns keyboard with tabs and pager", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "sessions",
      args: "",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response);
    assert.equal(typeof response?.text, "string");
    assert.equal(response?.text?.includes("sessions: ok"), true);
    assert.ok(response?.telegram?.inlineKeyboard);
    assert.equal(response?.telegram?.inlineKeyboard?.length, 2);
  });
});

test("/new uses command adapter type instead of hardcoded telegram", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "new",
      args: "",
      adapterType: "slack",
      chatId: "channel-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response?.text?.includes("session-new: ok"));
    const slackBinding = db.getChannelSessionBinding("nex", "slack", "channel-1");
    const telegramBinding = db.getChannelSessionBinding("nex", "telegram", "channel-1");
    assert.ok(slackBinding);
    assert.equal(telegramBinding, null);
  });
});

test("/abort uses adapter-specific reason", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    let abortReason = "";

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: (_agent: string, reason: string) => {
          abortReason = reason;
          return false;
        },
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    await handler({
      command: "abort",
      args: "",
      adapterType: "slack",
      chatId: "channel-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.equal(abortReason, "slack:/abort");
  });
});

test("/provider switches provider, clears overrides, and requests refresh", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({
      name: "nex",
      provider: "codex",
      model: "gpt-5-codex",
      reasoningEffort: "high",
    });

    let refreshReason = "";
    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
        requestSessionRefresh: (_agentName: string, reason: string) => {
          refreshReason = reason;
        },
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "provider",
      args: "claude",
      adapterType: "telegram",
      chatId: "chat-1",
      channelUserId: "u-1",
      channelUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response);
    assert.equal(typeof response?.text, "string");
    assert.equal(response?.text?.includes("provider-switch: ok"), true);

    const updated = db.getAgentByNameCaseInsensitive("nex");
    assert.ok(updated);
    assert.equal(updated?.provider, "claude");
    assert.equal(updated?.model, undefined);
    assert.equal(updated?.reasoningEffort, undefined);
    assert.equal(refreshReason, "telegram:/provider");
  });
});

test("/provider updates model and reasoning-effort without provider switch", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({
      name: "nex",
      provider: "codex",
      model: null,
      reasoningEffort: null,
    });

    let refreshReason = "";
    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
        requestSessionRefresh: (_agentName: string, reason: string) => {
          refreshReason = reason;
        },
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "provider",
      args: "codex model=gpt-5.3-codex reasoning-effort=high",
      adapterType: "telegram",
      chatId: "chat-1",
      channelUserId: "u-1",
      channelUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response);
    assert.equal(typeof response?.text, "string");
    assert.equal(response?.text?.includes("provider-switch: ok"), true);
    assert.equal(response?.text?.includes("new-model: gpt-5.3-codex"), true);
    assert.equal(response?.text?.includes("new-reasoning-effort: high"), true);

    const updated = db.getAgentByNameCaseInsensitive("nex");
    assert.ok(updated);
    assert.equal(updated?.provider, "codex");
    assert.equal(updated?.model, "gpt-5.3-codex");
    assert.equal(updated?.reasoningEffort, "high");
    assert.equal(refreshReason, "telegram:/provider");
  });
});

test("/provider without args returns usage", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "provider",
      args: "",
      adapterType: "telegram",
      chatId: "chat-1",
      channelUserId: "u-1",
      channelUsername: "alice",
      agentName: "nex",
    } as any);

    assert.equal(
      response?.text,
      "Usage: /provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]"
    );
  });
});

test("/trace returns usage when args are provided", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "claude" });
    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
      hibossDir: os.tmpdir(),
    });

    const response = await handler({
      command: "trace",
      args: "abcdef12",
      chatId: "chat-1",
      channelUserId: "u-1",
      channelUsername: "alice",
      agentName: "nex",
    } as any);

    assert.equal(response?.text, "Usage: /trace");
  });
});

test("/trace reads latest finished run trace", async () => {
  const hibossDir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-trace-test-"));
  await withTempDb(async (db) => {
    try {
      db.registerAgent({ name: "nex", provider: "claude" });
      const run = db.createAgentRun("nex", ["env-1"]);
      db.completeAgentRun(run.id, "done", 1234);
      writeAgentRunTrace(hibossDir, {
        version: INTERNAL_VERSION,
        runId: run.id,
        agentName: "nex",
        provider: "claude",
        status: "success",
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
        entries: [
          { type: "assistant", text: "I will check the repo." },
          { type: "tool-call", toolName: "Bash", text: "Bash input={\"cmd\":\"ls -la\"}" },
        ],
      });

      const handler = createChannelCommandHandler({
        db,
        executor: {
          isAgentBusy: () => false,
          abortCurrentRun: () => false,
          invalidateChannelSessionCache: () => undefined,
        } as any,
        router: { routeEnvelope: async () => undefined } as any,
        hibossDir,
      });

      const response = await handler({
        command: "trace",
        args: "",
        chatId: "chat-1",
        channelUserId: "u-1",
        channelUsername: "alice",
        agentName: "nex",
      } as any);

      assert.equal(response?.text?.includes("trace: ok"), true);
      assert.equal(response?.text?.includes("provider: claude"), true);
      assert.equal(response?.text?.includes("entry-1-type: assistant"), true);
      assert.equal(response?.text?.includes("entry-2-type: tool-call"), true);
    } finally {
      fs.rmSync(hibossDir, { recursive: true, force: true });
    }
  });
});

test("/trace shows live entries when current run is in progress", async () => {
  const hibossDir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-trace-live-test-"));
  await withTempDb(async (db) => {
    try {
      db.registerAgent({ name: "nex", provider: "claude" });
      const run = db.createAgentRun("nex", ["env-1"]);
      writeAgentRunTrace(hibossDir, {
        version: INTERNAL_VERSION,
        runId: run.id,
        agentName: "nex",
        provider: "claude",
        status: "running",
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
        entries: [
          { type: "assistant", text: "Working on it." },
          { type: "tool-call", toolName: "Bash", text: "Bash input={\"cmd\":\"ls -la\"}" },
        ],
      });

      const handler = createChannelCommandHandler({
        db,
        executor: {
          isAgentBusy: () => true,
          abortCurrentRun: () => false,
          invalidateChannelSessionCache: () => undefined,
        } as any,
        router: { routeEnvelope: async () => undefined } as any,
        hibossDir,
      });

      const response = await handler({
        command: "trace",
        args: "",
        chatId: "chat-1",
        channelUserId: "u-1",
        channelUsername: "alice",
        agentName: "nex",
      } as any);

      assert.equal(response?.text?.includes("trace: pending"), true);
      assert.equal(response?.text?.includes("entry-1-type: assistant"), true);
      assert.equal(response?.text?.includes("entry-2-type: tool-call"), true);
    } finally {
      fs.rmSync(hibossDir, { recursive: true, force: true });
    }
  });
});

test("/trace reads Codex run traces", async () => {
  const hibossDir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-trace-codex-test-"));
  await withTempDb(async (db) => {
    try {
      db.registerAgent({ name: "nex", provider: "codex" });
      const run = db.createAgentRun("nex", ["env-1"]);
      db.completeAgentRun(run.id, "done", 1234);
      writeAgentRunTrace(hibossDir, {
        version: INTERNAL_VERSION,
        runId: run.id,
        agentName: "nex",
        provider: "codex",
        status: "success",
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
        entries: [
          { type: "assistant", text: "I inspected the repo." },
          { type: "tool-call", toolName: "bash", text: "bash input={\"cmd\":\"ls\"}" },
        ],
      });

      const handler = createChannelCommandHandler({
        db,
        executor: {
          isAgentBusy: () => false,
          abortCurrentRun: () => false,
          invalidateChannelSessionCache: () => undefined,
        } as any,
        router: { routeEnvelope: async () => undefined } as any,
        hibossDir,
      });

      const response = await handler({
        command: "trace",
        args: "",
        chatId: "chat-1",
        channelUserId: "u-1",
        channelUsername: "alice",
        agentName: "nex",
      } as any);

      assert.equal(response?.text?.includes("trace: ok"), true);
      assert.equal(response?.text?.includes("provider: codex"), true);
      assert.equal(response?.text?.includes("entry-2-tool: bash"), true);
    } finally {
      fs.rmSync(hibossDir, { recursive: true, force: true });
    }
  });
});

test("/status resolves effective codex model/reasoning from CODEX_HOME config", async () => {
  await withTempDb(async (db) => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-codex-home-"));
    try {
      fs.writeFileSync(
        path.join(codexHome, "config.toml"),
        [
          "model_provider = \"custom\"",
          "model = \"gpt-5.3-codex\"",
          "model_reasoning_effort = \"high\"",
          "disable_response_storage = true",
          "",
          "[model_providers.custom]",
          "name = \"custom\"",
          "wire_api = \"responses\"",
          "requires_openai_auth = true",
          "base_url = \"https://cch.ethanelift.com/v1\"",
          "",
          "[features]",
          "multi_agent = true",
          "",
        ].join("\n"),
        "utf8"
      );

      db.registerAgent({
        name: "nex",
        provider: "codex",
        metadata: {
          providerCli: {
            codex: {
              env: {
                CODEX_HOME: codexHome,
              },
            },
          },
        },
      });

      const handler = createChannelCommandHandler({
        db,
        executor: {
          isAgentBusy: () => false,
          abortCurrentRun: () => false,
          invalidateChannelSessionCache: () => undefined,
        } as any,
        router: { routeEnvelope: async () => undefined } as any,
      });

      const response = await handler({
        command: "status",
        args: "",
        adapterType: "telegram",
        chatId: "chat-1",
        channelUserId: "u-1",
        channelUsername: "alice",
        agentName: "nex",
      } as any);

      assert.ok(response);
      assert.equal(response?.text?.includes("effective-model: gpt-5.3-codex"), true);
      assert.equal(response?.text?.includes("effective-reasoning-effort: high"), true);
      assert.equal(response?.text?.includes("codex-config-model-provider: custom"), true);
      assert.equal(response?.text?.includes("codex-config-features-multi-agent: true"), true);
      assert.equal(
        response?.text?.includes("codex-config-provider-base-url: https://cch.ethanelift.com/v1"),
        true
      );
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

test("/session not-found uses distinct message from invalid-id", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const invalid = await handler({
      command: "session",
      args: "not-a-hex-id",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);
    const notFound = await handler({
      command: "session",
      args: "aaaaaaaa",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.equal(invalid?.text, "error: Invalid session id");
    assert.equal(notFound?.text, "error: Session not found");
  });
});
