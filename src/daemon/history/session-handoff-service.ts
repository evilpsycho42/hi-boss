import * as fs from "node:fs";
import * as path from "node:path";

import type { Agent } from "../../agent/types.js";
import { executeOneShotPrompt } from "../../agent/oneshot-turn.js";
import { getProviderCliEnvOverrides } from "../../agent/provider-env.js";
import type { HiBossDatabase } from "../db/database.js";
import { resolveAgentWorkspace } from "../../team/runtime.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { DEFAULT_AGENT_PROVIDER } from "../../shared/defaults.js";
import { readSessionFile } from "./session-file-io.js";
import {
  ensureSessionMarkdownForJson,
  markSessionMarkdownClosed,
  markSessionMarkdownHandoffAttempt,
  markSessionMarkdownHandoffFailure,
  markSessionMarkdownHandoffReady,
  readSessionMarkdownFile,
} from "./session-markdown-file-io.js";

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

type HandoffResult = {
  summary: string;
  handoff: string;
};

function listDirs(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent)
      .map((name) => path.join(parent, name))
      .filter((fullPath) => {
        try {
          return fs.statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function listSessionJsonFiles(historyDir: string): string[] {
  const dateDirs = listDirs(historyDir)
    .filter((fullPath) => DATE_DIR_RE.test(path.basename(fullPath)))
    .sort()
    .reverse();

  const files: string[] = [];
  for (const dateDir of dateDirs) {
    const chatDirs = listDirs(dateDir);
    for (const chatDir of chatDirs) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(chatDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const fullPath = path.join(chatDir, entry);
        try {
          if (fs.statSync(fullPath).isFile()) {
            files.push(fullPath);
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  return files;
}

function normalizeReasoningEffort(value: Agent["reasoningEffort"]):
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | undefined {
  if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function buildHandoffPrompt(params: {
  agentName: string;
  sessionId: string;
  markdownBody: string;
}): string {
  return [
    "You are generating a compact session handoff record for future sessions.",
    "Return JSON only (no markdown, no code fences).",
    '{"summary":"...","handoff":"..."}',
    "Rules:",
    "- Write in the dominant language of the conversation.",
    "- Be concise and high-signal.",
    "- Do not include hidden reasoning/process.",
    "- `summary`: one short overview paragraph.",
    "- `handoff`: actionable continuation notes, including unfinished TODOs, unresolved issues, next steps, and likely user interests.",
    "",
    `agent-name: ${params.agentName}`,
    `session-id: ${params.sessionId}`,
    "",
    "session-conversation-markdown:",
    params.markdownBody.trim() || "(empty)",
  ].join("\n");
}

function parseHandoffJson(raw: string): HandoffResult {
  const text = raw.trim();

  const candidates: string[] = [text];
  if (text.startsWith("```") && text.endsWith("```")) {
    candidates.push(text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim());
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      const handoff = typeof parsed.handoff === "string" ? parsed.handoff.trim() : "";
      if (!summary && !handoff) continue;
      return { summary, handoff };
    } catch {
      // try next candidate
    }
  }

  throw new Error("invalid handoff JSON output");
}

async function generateHandoffWithProvider(params: {
  db: HiBossDatabase;
  hibossDir: string;
  agent: Agent;
  sessionId: string;
  markdownBody: string;
}): Promise<HandoffResult> {
  const provider = params.agent.provider ?? DEFAULT_AGENT_PROVIDER;
  const workspace = resolveAgentWorkspace({
    db: params.db,
    hibossDir: params.hibossDir,
    agent: params.agent,
  });

  const result = await executeOneShotPrompt({
    provider,
    workspace,
    prompt: buildHandoffPrompt({
      agentName: params.agent.name,
      sessionId: params.sessionId,
      markdownBody: params.markdownBody,
    }),
    envOverrides: getProviderCliEnvOverrides(params.agent.metadata, provider),
    model: params.agent.model ?? undefined,
    reasoningEffort: normalizeReasoningEffort(params.agent.reasoningEffort),
  });

  return parseHandoffJson(result.finalText);
}

export class SessionHandoffService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;

  constructor(
    private readonly params: {
      db: HiBossDatabase;
      hibossDir: string;
      intervalMs?: number;
      generateHandoff?: (args: {
        db: HiBossDatabase;
        hibossDir: string;
        agent: Agent;
        sessionId: string;
        markdownBody: string;
      }) => Promise<HandoffResult>;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = this.params.intervalMs ?? 30_000;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  trigger(): void {
    if (!this.running) return;
    void this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const agents = this.params.db.listAgents();
      for (const agent of agents) {
        await this.processAgent(agent);
      }
    } catch (err) {
      logEvent("warn", "session-handoff-run-failed", {
        error: errorMessage(err),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private async processAgent(agent: Agent): Promise<void> {
    const historyDir = path.join(this.params.hibossDir, "agents", agent.name, "internal_space", "history");
    if (!fs.existsSync(historyDir)) return;

    const runtime = this.params.db.getRuntimeSessionHandoffConfig();
    const files = listSessionJsonFiles(historyDir);

    for (const sessionJsonPath of files) {
      const session = readSessionFile(sessionJsonPath);
      if (!session) continue;

      const markdownPath = ensureSessionMarkdownForJson({
        sessionJsonPath,
        session,
      });

      const doc = readSessionMarkdownFile(markdownPath);
      if (!doc) continue;

      // Keep markdown ended-at aligned with JSON for recovered historical sessions.
      if (session.endedAtMs !== null && !doc.frontmatter.endedAt) {
        markSessionMarkdownClosed(markdownPath, session.endedAtMs);
      }

      if (session.endedAtMs === null) {
        continue;
      }

      if (doc.frontmatter.handoffStatus === "ready") {
        continue;
      }

      if (doc.frontmatter.handoffStatus === "failed" && doc.frontmatter.handoffAttempts >= runtime.maxRetries) {
        continue;
      }

      const attemptDoc = markSessionMarkdownHandoffAttempt(markdownPath);
      if (!attemptDoc) continue;

      try {
        const generate = this.params.generateHandoff ?? generateHandoffWithProvider;
        const generated = await generate({
          db: this.params.db,
          hibossDir: this.params.hibossDir,
          agent,
          sessionId: session.sessionId,
          markdownBody: attemptDoc.body,
        });
        markSessionMarkdownHandoffReady({
          filePath: markdownPath,
          summary: generated.summary,
          handoff: generated.handoff,
        });
      } catch (err) {
        const attempts = attemptDoc.frontmatter.handoffAttempts;
        const terminal = attempts >= runtime.maxRetries;
        markSessionMarkdownHandoffFailure({
          filePath: markdownPath,
          error: errorMessage(err),
          terminal,
        });
        logEvent("warn", "session-handoff-generate-failed", {
          "agent-name": agent.name,
          "session-id": session.sessionId,
          attempts,
          terminal,
          error: errorMessage(err),
        });
      }
    }
  }
}
