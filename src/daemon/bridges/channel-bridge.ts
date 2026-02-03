import type {
  ChatAdapter,
  ChannelMessage,
  ChannelCommand,
  ChannelCommandHandler,
  MessageContent,
} from "../../adapters/types.js";
import { formatChannelAddress, formatAgentAddress } from "../../adapters/types.js";
import type { MessageRouter } from "../router/message-router.js";
import type { HiBossDatabase } from "../db/database.js";
import type { DaemonConfig } from "../daemon.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";

/**
 * Bridge between ChannelMessages and Envelopes.
 * Converts incoming platform messages to internal envelopes.
 */
export class ChannelBridge {
  private adapterTokens: Map<ChatAdapter, string> = new Map();
  private commandHandler: ChannelCommandHandler | null = null;

  private static getUnboundAdapterText(platform: string): string {
    return [
      `not-configured: no agent is bound to this ${platform} bot`,
      `fix: hiboss agent set --token <boss-token> --name <agent-name> --bind-adapter-type ${platform} --bind-adapter-token <adapter-token>`,
    ].join("\n");
  }

  constructor(
    private router: MessageRouter,
    private db: HiBossDatabase,
    private config: DaemonConfig
  ) {}

  /**
   * Set the command handler for all adapters.
   */
  setCommandHandler(handler: ChannelCommandHandler): void {
    this.commandHandler = handler;
  }

  /**
   * Connect an adapter to the bridge.
   * Incoming messages will be converted to envelopes and routed.
   */
  connect(adapter: ChatAdapter, adapterToken: string): void {
    this.adapterTokens.set(adapter, adapterToken);
    this.router.registerAdapter(adapter, adapterToken);

    adapter.onMessage(async (message) => {
      await this.handleChannelMessage(adapter, adapterToken, message);
    });

    // Connect command handler if adapter supports it
    if (adapter.onCommand && this.commandHandler) {
      adapter.onCommand(async (command) => {
        return await this.handleCommand(adapter, adapterToken, command);
      });
    }
  }

  private async handleCommand(
    adapter: ChatAdapter,
    adapterToken: string,
    command: ChannelCommand
  ): Promise<MessageContent | void> {
    const fromBoss = this.isBoss(adapter.platform, command.authorUsername);
    if (!fromBoss) {
      // Boss-only commands: do not reply to non-boss users.
      return;
    }

    // Find the agent bound to this adapter
    const binding = this.db.getBindingByAdapter(adapter.platform, adapterToken);
    if (!binding) {
      logEvent("warn", "channel-no-binding", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        "from-boss": fromBoss,
      });

      return { text: ChannelBridge.getUnboundAdapterText(adapter.platform) };
    }

    // Enrich command with agent name
    const enrichedCommand: ChannelCommand & { agentName: string } = {
      ...command,
      agentName: binding.agentName,
    };

    if (this.commandHandler) {
      return await this.commandHandler(enrichedCommand);
    }
  }

  private async handleChannelMessage(
    adapter: ChatAdapter,
    adapterToken: string,
    message: ChannelMessage
  ): Promise<void> {
    const platform = adapter.platform;
    const fromBoss = this.isBoss(platform, message.author.username);

    // Find the agent bound to this adapter
    const binding = this.db.getBindingByAdapter(platform, adapterToken);
    if (!binding) {
      logEvent("warn", "channel-no-binding", {
        "message-kind": "message",
        "adapter-type": platform,
        "chat-id": message.chat.id,
        "from-boss": fromBoss,
      });

      if (fromBoss) {
        try {
          await adapter.sendMessage(message.chat.id, {
            text: ChannelBridge.getUnboundAdapterText(platform),
          });
        } catch (err) {
          logEvent("warn", "channel-send-failed", {
            "message-kind": "message",
            "adapter-type": platform,
            "chat-id": message.chat.id,
            error: errorMessage(err),
          });
        }
      }
      return;
    }

    const fromAddress = formatChannelAddress(platform, message.chat.id);
    const toAddress = formatAgentAddress(binding.agentName);

    await this.router.routeEnvelope({
      from: fromAddress,
      to: toAddress,
      fromBoss,
      content: {
        text: message.content.text,
        attachments: message.content.attachments?.map((a) => ({
          source: a.source,
          filename: a.filename,
          telegramFileId: a.telegramFileId,
        })),
      },
      metadata: {
        platform,
        channelMessageId: message.id,
        author: message.author,
        chat: message.chat,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      },
    });
  }

  private isBoss(platform: string, username?: string): boolean {
    if (!username) return false;

    const adapterBossId = this.db.getAdapterBossId(platform);
    if (!adapterBossId) return false;

    // Normalize comparison (handle @username vs username)
    const normalizedBoss = adapterBossId.replace(/^@/, '').toLowerCase();
    const normalizedUser = username.replace(/^@/, '').toLowerCase();

    return normalizedBoss === normalizedUser;
  }
}
