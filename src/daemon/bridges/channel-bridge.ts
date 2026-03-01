import type {
  ChatAdapter,
  ChannelMessage,
  ChannelCommand,
  ChannelCommandResponse,
  ChannelCommandHandler,
} from "../../adapters/types.js";
import { formatChannelAddress, formatAgentAddress } from "../../adapters/types.js";
import type { MessageRouter } from "../router/message-router.js";
import type { HiBossDatabase } from "../db/database.js";
import type { DaemonConfig } from "../daemon.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { resolveUiLocale } from "../../shared/ui-locale.js";
import { getUiText } from "../../shared/ui-text.js";
import { DEFAULT_AGENT_PROVIDER } from "../../shared/defaults.js";
import {
  evaluateUserPermission,
  parseUserPermissionPolicyOrNull,
} from "../../shared/user-permissions.js";

/**
 * Bridge between ChannelMessages and Envelopes.
 * Converts incoming platform messages to internal envelopes.
 */
export class ChannelBridge {
  private adapterTokens: Map<ChatAdapter, string> = new Map();
  private commandHandler: ChannelCommandHandler | null = null;

  private getUnboundAdapterText(platform: string): string {
    const ui = getUiText(resolveUiLocale(this.db.getConfig("ui_locale")));
    return ui.bridge.unboundAdapter(platform);
  }

  constructor(
    private router: MessageRouter,
    private db: HiBossDatabase,
    private config: DaemonConfig
  ) {}

  private getChannelAccessDeniedText(): string {
    const ui = getUiText(resolveUiLocale(this.db.getConfig("ui_locale")));
    return ui.channel.accessDenied;
  }

  private getUserPermissionPolicy() {
    return parseUserPermissionPolicyOrNull(this.db.getConfig("user_permission_policy"));
  }

  private commandToAction(commandNameRaw: string): string {
    const commandName = commandNameRaw.trim().replace(/^\//, "").toLowerCase();
    return `channel.command.${commandName || "unknown"}`;
  }

  private isActionAllowed(params: {
    adapterType: string;
    channelUserId?: string;
    channelUsername?: string;
    fromBoss: boolean;
    action: string;
  }): { allowed: boolean; role: string } {
    const policy = this.getUserPermissionPolicy();
    if (!policy) {
      // Legacy behavior when no explicit channel user policy is configured.
      if (params.action.startsWith("channel.command.")) {
        return { allowed: params.fromBoss, role: params.fromBoss ? "boss" : "unmapped" };
      }
      if (params.action === "channel.message.send") {
        return { allowed: true, role: params.fromBoss ? "boss" : "unmapped" };
      }
      return { allowed: false, role: params.fromBoss ? "boss" : "unmapped" };
    }
    const decision = evaluateUserPermission(
      policy,
      {
        adapterType: params.adapterType,
        channelUserId: params.channelUserId,
        channelUsername: params.channelUsername,
        fromBoss: params.fromBoss,
      },
      params.action
    );
    return { allowed: decision.allowed, role: decision.role };
  }

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
  ): Promise<ChannelCommandResponse | void> {
    const fromBoss = this.isBoss(adapter.platform, command.channelUsername);
    const action = this.commandToAction(command.command);
    const authz = this.isActionAllowed({
      adapterType: adapter.platform,
      channelUserId: command.channelUserId,
      channelUsername: command.channelUsername,
      fromBoss,
      action,
    });
    if (!authz.allowed) {
      const hasPolicy = Boolean((this.db.getConfig("user_permission_policy") ?? "").trim());
      logEvent("info", "channel-authz-denied", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        "from-boss": fromBoss,
        action,
        role: authz.role,
      });
      // Legacy mode keeps silent drop for non-boss commands.
      if (!hasPolicy) return;
      return { text: this.getChannelAccessDeniedText() };
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

      return { text: this.getUnboundAdapterText(adapter.platform) };
    }

    // Enrich command with agent name
    const enrichedCommand: ChannelCommand & { agentName: string } = {
      ...command,
      adapterType: command.adapterType ?? adapter.platform,
      fromBoss,
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
    const fromBoss = this.isBoss(platform, message.channelUser.username);
    const hasUserPermissionPolicy = this.getUserPermissionPolicy() !== null;
    const authz = this.isActionAllowed({
      adapterType: platform,
      channelUserId: message.channelUser.id,
      channelUsername: message.channelUser.username,
      fromBoss,
      action: "channel.message.send",
    });
    if (!authz.allowed) {
      logEvent("info", "channel-authz-denied", {
        "message-kind": "message",
        "adapter-type": platform,
        "chat-id": message.chat.id,
        "from-boss": fromBoss,
        action: "channel.message.send",
        role: authz.role,
      });
      return;
    }

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
            text: this.getUnboundAdapterText(platform),
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
    const agent = this.db.getAgentByNameCaseInsensitive(binding.agentName);
    const ownerUserId = hasUserPermissionPolicy
      ? message.channelUser.id
      : (fromBoss ? message.channelUser.id : undefined);
    const channelDefaultSession = agent
      ? this.db.getOrCreateChannelDefaultSession({
          agentName: binding.agentName,
          adapterType: platform,
          chatId: message.chat.id,
          ownerUserId,
          provider: agent.provider ?? DEFAULT_AGENT_PROVIDER,
        })
      : null;

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
        origin: "channel",
        platform,
        channelMessageId: message.id,
        ...(channelDefaultSession ? { channelSessionId: channelDefaultSession.session.id } : {}),
        channelUser: message.channelUser,
        chat: message.chat,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      },
    });
  }

  private isBoss(platform: string, username?: string): boolean {
    if (!username) return false;

    const adapterBossIds = this.db.getAdapterBossIds(platform);
    if (adapterBossIds.length < 1) return false;

    const normalizedUser = username.replace(/^@/, '').toLowerCase();

    return adapterBossIds.some((id) => id.toLowerCase() === normalizedUser);
  }
}
