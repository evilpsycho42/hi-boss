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
import type { CreateEnvelopeInput } from "../../envelope/types.js";
import { ChannelMessageBatcher } from "./channel-message-batcher.js";
import {
  evaluateUserPermissionByToken,
  parseUserPermissionPolicy,
  resolveUserPermissionUserByToken,
} from "../../shared/user-permissions.js";

/**
 * Bridge between ChannelMessages and Envelopes.
 * Converts incoming platform messages to internal envelopes.
 */
export class ChannelBridge {
  private adapterTokens: Map<ChatAdapter, string> = new Map();
  private commandHandler: ChannelCommandHandler | null = null;
  private channelMessageBatcher: ChannelMessageBatcher;

  private getUnboundAdapterText(platform: string): string {
    const ui = getUiText(resolveUiLocale(this.db.getConfig("ui_locale")));
    return ui.bridge.unboundAdapter(platform);
  }

  constructor(
    private router: MessageRouter,
    private db: HiBossDatabase,
    private config: DaemonConfig
  ) {
    this.channelMessageBatcher = new ChannelMessageBatcher(async (input, batchSize) => {
      try {
        await this.router.routeEnvelope(input);
      } catch (err) {
        logEvent("error", "channel-batch-route-failed", {
          from: input.from,
          to: input.to,
          "batch-size": batchSize,
          error: errorMessage(err),
        });
      }
    });
  }

  private getChannelAccessDeniedText(): string {
    const ui = getUiText(resolveUiLocale(this.db.getConfig("ui_locale")));
    return ui.channel.accessDenied;
  }

  private getChannelLoginRequiredText(): string {
    const ui = getUiText(resolveUiLocale(this.db.getConfig("ui_locale")));
    return ui.channel.loginRequired;
  }

  private getChannelLoginUsageText(): string {
    const ui = getUiText(resolveUiLocale(this.db.getConfig("ui_locale")));
    return ui.channel.loginUsage;
  }

  private getChannelLoginOkText(params: {
    token: string;
    fromBoss: boolean;
    userName: string;
    role: "admin" | "user";
  }): string {
    const ui = getUiText(resolveUiLocale(this.db.getConfig("ui_locale")));
    return ui.channel.loginOk({
      tokenPrefix: params.token.slice(0, 8),
      fromBoss: params.fromBoss,
      userName: params.userName,
      role: params.role,
    });
  }

  private getUserPermissionPolicy() {
    const raw = (this.db.getConfig("user_permission_policy") ?? "").trim();
    if (!raw) {
      throw new Error("Missing required config: user_permission_policy");
    }
    return parseUserPermissionPolicy(raw);
  }

  private normalizeCommandName(commandNameRaw: string): string {
    return commandNameRaw.trim().replace(/^\//, "").toLowerCase();
  }

  private resolveTokenAuthorization(params: {
    token: string;
    targetAgentName: string;
  }): { allowed: boolean; token?: string; fromBoss: boolean; role?: "admin" | "user"; userName?: string } {
    const policy = this.getUserPermissionPolicy();
    const decision = evaluateUserPermissionByToken(policy, params.token, params.targetAgentName);
    return {
      allowed: decision.allowed,
      token: decision.token,
      fromBoss: decision.fromBoss,
      role: decision.role,
      userName: decision.userName,
    };
  }

  private resolveBossByToken(token: string): boolean {
    const policy = this.getUserPermissionPolicy();
    const user = resolveUserPermissionUserByToken(policy, token);
    return user?.role === "admin";
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

    // Connect command entrypoint if adapter supports it.
    // /login is handled in the bridge itself, so this must not depend on commandHandler presence.
    if (adapter.onCommand) {
      adapter.onCommand(async (command) => {
        return await this.handleCommand(adapter, adapterToken, command);
      });
    }
  }

  private async handleLoginCommand(
    adapter: ChatAdapter,
    command: ChannelCommand
  ): Promise<ChannelCommandResponse> {
    const channelUserId = command.channelUserId?.trim() ?? "";
    const channelUsername = command.channelUsername?.trim().replace(/^@/, "").toLowerCase() ?? "";
    if (!channelUserId && !channelUsername) {
      return { text: this.getChannelLoginUsageText() };
    }
    const token = (command.args ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? "";
    if (!token) {
      return { text: this.getChannelLoginUsageText() };
    }

    const policy = this.getUserPermissionPolicy();
    const user = resolveUserPermissionUserByToken(policy, token);
    if (!user) {
      logEvent("info", "channel-login-denied", {
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
        ...(channelUsername ? { "channel-username": channelUsername } : {}),
        "token-prefix": token.slice(0, 8).toLowerCase(),
      });
      return { text: this.getChannelAccessDeniedText() };
    }

    this.db.setChannelUserAuth({
      adapterType: adapter.platform,
      channelUserId: channelUserId || undefined,
      token: user.token,
      channelUsername: channelUsername || undefined,
    });
    logEvent("info", "channel-login-ok", {
      "adapter-type": adapter.platform,
      "chat-id": command.chatId,
      ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
      ...(channelUsername ? { "channel-username": channelUsername } : {}),
      "token-prefix": user.token.slice(0, 8),
      role: user.role,
    });

    return {
      text: this.getChannelLoginOkText({
        token: user.token,
        fromBoss: user.role === "admin",
        userName: user.name,
        role: user.role,
      }),
    };
  }

  private async handleCommand(
    adapter: ChatAdapter,
    adapterToken: string,
    command: ChannelCommand
  ): Promise<ChannelCommandResponse | void> {
    const channelUserId = command.channelUserId?.trim() ?? "";
    const channelUsername = command.channelUsername?.trim().replace(/^@/, "").toLowerCase() ?? "";
    // Find the agent bound to this adapter
    const binding = this.db.getBindingByAdapter(adapter.platform, adapterToken);
    if (!binding) {
      const loggedInToken = channelUserId || channelUsername
        ? this.db.getChannelUserAuthToken({
            adapterType: adapter.platform,
            channelUserId: channelUserId || undefined,
            channelUsername: channelUsername || undefined,
          })
        : undefined;
      const fromBoss = loggedInToken ? this.resolveBossByToken(loggedInToken) : false;
      logEvent("warn", "channel-no-binding", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
        ...(channelUsername ? { "channel-username": channelUsername } : {}),
        "from-boss": fromBoss,
      });

      return { text: this.getUnboundAdapterText(adapter.platform) };
    }

    const commandName = this.normalizeCommandName(command.command);
    if (commandName === "login") {
      return this.handleLoginCommand(adapter, command);
    }
    if (!channelUserId && !channelUsername) {
      return { text: this.getChannelLoginRequiredText() };
    }

    const loggedInToken = this.db.getChannelUserAuthToken({
      adapterType: adapter.platform,
      channelUserId: channelUserId || undefined,
      channelUsername: channelUsername || undefined,
    });
    if (!loggedInToken) {
      logEvent("info", "channel-authz-denied-not-logged-in", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
        ...(channelUsername ? { "channel-username": channelUsername } : {}),
        "target-agent": binding.agentName,
      });
      return { text: this.getChannelLoginRequiredText() };
    }

    const authz = this.resolveTokenAuthorization({
      token: loggedInToken,
      targetAgentName: binding.agentName,
    });
    const fromBoss = authz.fromBoss;
    if (!authz.allowed) {
      logEvent("info", "channel-authz-denied", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
        ...(channelUsername ? { "channel-username": channelUsername } : {}),
        "from-boss": fromBoss,
        "target-agent": binding.agentName,
        "token-prefix": loggedInToken.slice(0, 8),
      });
      return { text: this.getChannelAccessDeniedText() };
    }
    if (!authz.token) {
      logEvent("warn", "channel-authz-denied-missing-token", {
        "message-kind": "command",
        "adapter-type": adapter.platform,
        "chat-id": command.chatId,
        "target-agent": binding.agentName,
      });
      return { text: this.getChannelAccessDeniedText() };
    }

    // Enrich command with agent name
    const enrichedCommand: ChannelCommand & { agentName: string } = {
      ...command,
      command: commandName,
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
    const channelUserId = message.channelUser.id?.trim() ?? "";
    const channelUsername = message.channelUser.username?.trim().replace(/^@/, "").toLowerCase() ?? "";

    // Find the agent bound to this adapter
    const binding = this.db.getBindingByAdapter(platform, adapterToken);
    if (!binding) {
      const loggedInToken = channelUserId || channelUsername
        ? this.db.getChannelUserAuthToken({
            adapterType: platform,
            channelUserId: channelUserId || undefined,
            channelUsername: channelUsername || undefined,
          })
        : undefined;
      const fromBoss = loggedInToken ? this.resolveBossByToken(loggedInToken) : false;
      logEvent("warn", "channel-no-binding", {
        "message-kind": "message",
        "adapter-type": platform,
        "chat-id": message.chat.id,
        ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
        ...(channelUsername ? { "channel-username": channelUsername } : {}),
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

    const loggedInToken = channelUserId || channelUsername
      ? this.db.getChannelUserAuthToken({
          adapterType: platform,
          channelUserId: channelUserId || undefined,
          channelUsername: channelUsername || undefined,
        })
      : undefined;
    if (!loggedInToken) {
      logEvent("info", "channel-authz-denied-not-logged-in", {
        "message-kind": "message",
        "adapter-type": platform,
        "chat-id": message.chat.id,
        ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
        ...(channelUsername ? { "channel-username": channelUsername } : {}),
        "target-agent": binding.agentName,
      });
      try {
        await adapter.sendMessage(message.chat.id, {
          text: this.getChannelLoginRequiredText(),
        });
      } catch (err) {
        logEvent("warn", "channel-send-failed", {
          "message-kind": "message",
          "adapter-type": platform,
          "chat-id": message.chat.id,
          error: errorMessage(err),
        });
      }
      return;
    }

    const authz = this.resolveTokenAuthorization({
      token: loggedInToken,
      targetAgentName: binding.agentName,
    });
    const fromBoss = authz.fromBoss;
    if (!authz.allowed) {
      logEvent("info", "channel-authz-denied", {
        "message-kind": "message",
        "adapter-type": platform,
        "chat-id": message.chat.id,
        ...(channelUserId ? { "channel-user-id": channelUserId } : {}),
        ...(channelUsername ? { "channel-username": channelUsername } : {}),
        "from-boss": fromBoss,
        "target-agent": binding.agentName,
        "token-prefix": loggedInToken.slice(0, 8),
      });
      return;
    }
    if (!authz.token) {
      logEvent("warn", "channel-authz-denied-missing-token", {
        "message-kind": "message",
        "adapter-type": platform,
        "chat-id": message.chat.id,
        "target-agent": binding.agentName,
      });
      return;
    }

    const fromAddress = formatChannelAddress(platform, message.chat.id);
    const toAddress = formatAgentAddress(binding.agentName);
    const agent = this.db.getAgentByNameCaseInsensitive(binding.agentName);
    const ownerUserId = authz.token;
    const channelSession = agent
      ? this.db.getOrCreateChannelDefaultSession({
          agentName: binding.agentName,
          adapterType: platform,
          chatId: message.chat.id,
          ownerUserId,
          provider: agent.provider ?? DEFAULT_AGENT_PROVIDER,
        })
      : null;

    const envelopeInput: CreateEnvelopeInput = {
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
    };

    this.channelMessageBatcher.enqueue(message, envelopeInput);
  }
}
