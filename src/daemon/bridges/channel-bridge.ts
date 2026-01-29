import type { ChatAdapter, ChannelMessage, ChannelCommand, ChannelCommandHandler } from "../../adapters/types.js";
import { formatChannelAddress, formatAgentAddress } from "../../adapters/types.js";
import type { MessageRouter } from "../router/message-router.js";
import type { HiBossDatabase } from "../db/database.js";
import type { DaemonConfig } from "../daemon.js";
import { nowLocalIso } from "../../shared/time.js";

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
      `fix: hiboss agent bind --name <agent-name> --adapter-type ${platform} --adapter-token <adapter-token>`,
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
        await this.handleCommand(adapter, adapterToken, command);
      });
    }
  }

  private async handleCommand(
    adapter: ChatAdapter,
    adapterToken: string,
    command: ChannelCommand
  ): Promise<void> {
    const fromBoss = this.isBoss(adapter.platform, command.authorUsername);

    // Find the agent bound to this adapter
    const binding = this.db.getBindingByAdapter(adapter.platform, adapterToken);
    if (!binding) {
      console.warn(
        `[channel-bridge] no-binding: true platform: ${adapter.platform} chat-id: ${command.chatId} from-boss: ${fromBoss}`
      );

      if (fromBoss) {
        try {
          await adapter.sendMessage(command.chatId, {
            text: ChannelBridge.getUnboundAdapterText(adapter.platform),
          });
        } catch (err) {
          console.warn(`[channel-bridge] send-failed: true error: ${(err as Error).message}`);
        }
      }
      return;
    }

    // Enrich command with agent name
    const enrichedCommand: ChannelCommand & { agentName: string } = {
      ...command,
      agentName: binding.agentName,
    };

    if (this.commandHandler) {
      await this.commandHandler(enrichedCommand);
    }
  }

  private async handleChannelMessage(
    adapter: ChatAdapter,
    adapterToken: string,
    message: ChannelMessage
  ): Promise<void> {
    const platform = adapter.platform;
    const fromBoss = this.isBoss(platform, message.author.username);

    // Debug logging for ChannelMessage
    if (this.config.debug) {
      console.log(`[${nowLocalIso()}] [ChannelBridge] ChannelMessage received:`);
      console.log(JSON.stringify({
        id: message.id,
        platform: message.platform,
        author: message.author,
        chat: message.chat,
        content: {
          text: message.content.text,
          attachments: message.content.attachments?.length ?? 0,
        },
      }, null, 2));
    }

    // Find the agent bound to this adapter
    const binding = this.db.getBindingByAdapter(platform, adapterToken);
    if (!binding) {
      console.warn(
        `[channel-bridge] no-binding: true platform: ${platform} chat-id: ${message.chat.id} from-boss: ${fromBoss}`
      );

      if (fromBoss) {
        try {
          await adapter.sendMessage(message.chat.id, {
            text: ChannelBridge.getUnboundAdapterText(platform),
          });
        } catch (err) {
          console.warn(`[channel-bridge] send-failed: true error: ${(err as Error).message}`);
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

    console.log(`[${nowLocalIso()}] [ChannelBridge] Routed message from ${fromAddress} to ${toAddress}`);
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
