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
  parseUserPermissionPolicy,
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
    const raw = (this.db.getConfig("user_permission_policy") ?? "").trim();
    if (!raw) {
      throw new Error("Missing required config: user_permission_policy");
    }
    return parseUserPermissionPolicy(raw);
  }

  private commandToAction(commandNameRaw: string): string {
    const commandName = commandNameRaw.trim().replace(/^\//, "").toLowerCase();
    return `channel.command.${commandName || "unknown"}`;
  }

  private isActionAllowed(params: {
    adapterType: string;
    channelUserId?: string;
    channelUsername?: string;
    action: string;
  }): { allowed: boolean; role: string; token?: string } {
    const policy = this.getUserPermissionPolicy();
    const decision = evaluateUserPermission(
      policy,
      {
        adapterType: params.adapterType,
        channelUserId: params.channelUserId,
        channelUsername: params.channelUsername,
      },
      params.action
    );
    return { allowed: decision.allowed, role: decision.role, token: decision.token };
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
    const action = this.commandToAction(command.command);
    const authz = this.isActionAllowed({
      adapterType: adapter.platform,
      channelUserId: command.channelUserId,
      channelUsername: command.channelUsername,
      action,
    });
    const fromBoss = authz.role === "boss";
    if (!authz.allowed) {
      logEvent("info", "channel-authz-denied", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        "from-boss": fromBoss,
        action,
        role: authz.role,
      });
      return { text: this.getChannelAccessDeniedText() };
    }
    if (!authz.token) {
      logEvent("warn", "channel-authz-denied-missing-token", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        action,
        role: authz.role,
      });
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
      userToken: authz.token,
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
    const authz = this.isActionAllowed({
      adapterType: platform,
      channelUserId: message.channelUser.id,
      channelUsername: message.channelUser.username,
      action: "channel.message.send",
    });
    const fromBoss = authz.role === "boss";
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
    if (!authz.token) {
      logEvent("warn", "channel-authz-denied-missing-token", {
        "message-kind": "message",
        "adapter-type": platform,
        "chat-id": message.chat.id,
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
    const ownerUserId = authz.token;
    const channelSession = agent
      ? this.db.getOrCreateChannelActiveSession({
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
        userToken: authz.token,
        ...(channelSession ? { channelSessionId: channelSession.session.id } : {}),
        channelUser: message.channelUser,
        chat: message.chat,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      },
    });
  }
}
