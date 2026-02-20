import type { ChatAdapter } from "../adapters/types.js";
import { parseAddress } from "../adapters/types.js";
import type { Envelope } from "../envelope/types.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";

type TypingTarget = {
  adapterToken: string;
  chatId: string;
};

type TelegramBindingLookup = {
  getAgentBindingByType(agentName: string, adapterType: string): { adapterToken: string } | null;
};

function targetKey(target: TypingTarget): string {
  return `${target.adapterToken}:${target.chatId}`;
}

/**
 * Keeps Telegram "typing…" state aligned with agent run lifecycle.
 */
export class TelegramTypingManager {
  private runTargets = new Map<string, TypingTarget[]>();
  private activeTargetRefCount = new Map<string, number>();

  constructor(
    private readonly db: TelegramBindingLookup,
    private readonly adaptersByToken: Map<string, ChatAdapter>,
  ) {}

  async onRunStarted(params: {
    runId: string;
    agentName: string;
    envelopes: Envelope[];
  }): Promise<void> {
    const targets = this.resolveTargets(params.agentName, params.envelopes);
    if (targets.length === 0) return;

    this.runTargets.set(params.runId, targets);
    for (const target of targets) {
      const key = targetKey(target);
      const count = this.activeTargetRefCount.get(key) ?? 0;
      this.activeTargetRefCount.set(key, count + 1);
      if (count === 0) {
        await this.setTyping(target, true, params.runId);
      }
    }
  }

  async onRunFinished(params: { runId: string }): Promise<void> {
    const targets = this.runTargets.get(params.runId);
    this.runTargets.delete(params.runId);
    if (!targets) return;

    for (const target of targets) {
      const key = targetKey(target);
      const count = this.activeTargetRefCount.get(key) ?? 0;
      if (count <= 1) {
        this.activeTargetRefCount.delete(key);
        await this.setTyping(target, false, params.runId);
      } else {
        this.activeTargetRefCount.set(key, count - 1);
      }
    }
  }

  private resolveTargets(agentName: string, envelopes: Envelope[]): TypingTarget[] {
    const telegramBinding = this.db.getAgentBindingByType(agentName, "telegram");
    if (!telegramBinding) return [];

    const chatIds = new Set<string>();
    for (const envelope of envelopes) {
      try {
        const from = parseAddress(envelope.from);
        if (from.type === "channel" && from.adapter === "telegram" && from.chatId.trim()) {
          chatIds.add(from.chatId);
        }
      } catch {
        // Best-effort: ignore malformed sender addresses.
      }
    }

    return [...chatIds].map((chatId) => ({
      adapterToken: telegramBinding.adapterToken,
      chatId,
    }));
  }

  private async setTyping(target: TypingTarget, active: boolean, runId: string): Promise<void> {
    const adapter = this.adaptersByToken.get(target.adapterToken);
    if (!adapter?.setTyping) return;

    try {
      await adapter.setTyping(target.chatId, active);
    } catch (err) {
      logEvent("warn", "telegram-typing-update-failed", {
        "agent-run-id": runId,
        "chat-id": target.chatId,
        active,
        error: errorMessage(err),
      });
    }
  }
}
