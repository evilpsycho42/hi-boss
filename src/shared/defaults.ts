import * as os from "os";
import * as path from "path";
import type { PermissionPolicyV1 } from "./permissions.js";

// ==================== Hi-Boss Paths ====================

export const DEFAULT_HIBOSS_DIRNAME = ".hiboss";
export const DEFAULT_DB_FILENAME = "hiboss.db";
export const DEFAULT_SOCKET_FILENAME = "daemon.sock";
export const DEFAULT_PID_FILENAME = "daemon.pid";
export const DEFAULT_MEDIA_DIRNAME = "media";
export const DEFAULT_AGENTS_DIRNAME = "agents";

export function getDefaultHiBossDir(): string {
  return path.join(os.homedir(), DEFAULT_HIBOSS_DIRNAME);
}

export function getDefaultMediaDir(): string {
  return path.join(getDefaultHiBossDir(), DEFAULT_MEDIA_DIRNAME);
}

// ==================== Agent Defaults ====================

export const DEFAULT_AGENT_PROVIDER = "claude" as const;
export const DEFAULT_AGENT_REASONING_EFFORT = "medium" as const;
export const DEFAULT_AGENT_AUTO_LEVEL = "high" as const;
export const DEFAULT_AGENT_PERMISSION_LEVEL = "standard" as const;

// ==================== DB/Envelope Defaults ====================

export const DEFAULT_ENVELOPE_STATUS = "pending" as const;
export const DEFAULT_AGENT_RUN_STATUS = "running" as const;
export const DEFAULT_ENVELOPE_LIST_BOX = "inbox" as const;

// ==================== Setup Defaults ====================

export const DEFAULT_SETUP_PROVIDER = DEFAULT_AGENT_PROVIDER;
export const DEFAULT_SETUP_AGENT_NAME = "nex" as const;
export const DEFAULT_SETUP_REASONING_EFFORT = DEFAULT_AGENT_REASONING_EFFORT;
export const DEFAULT_SETUP_AUTO_LEVEL = DEFAULT_AGENT_AUTO_LEVEL;
export const DEFAULT_SETUP_BIND_TELEGRAM = true as const;

export const DEFAULT_SETUP_MODEL_BY_PROVIDER = {
  claude: "opus",
  codex: "gpt-5.2",
} as const;

export const SETUP_MODEL_CHOICES_BY_PROVIDER = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.2", "gpt-5.2-codex"],
} as const;

export function getDefaultSetupAgentDescription(agentName: string): string {
  return `${agentName} - AI assistant`;
}

export function getDefaultSetupBossName(): string {
  return os.userInfo().username;
}

export function getDefaultSetupWorkspace(): string {
  return os.homedir();
}

// ==================== Permissions ====================

export const DEFAULT_PERMISSION_POLICY: PermissionPolicyV1 = {
  version: 1,
  operations: {
    // Envelope operations (agents)
    "envelope.send": "restricted",
    "envelope.list": "restricted",
    "envelope.get": "restricted",
    "turn.preview": "restricted",

    // Backwards-compatible aliases
    "message.send": "restricted",
    "message.list": "restricted",
    "message.get": "restricted",

    // Reactions
    "reaction.set": "restricted",

    // Daemon read-only
    "daemon.status": "boss",
    "daemon.ping": "standard",

    // Admin operations (boss-only by default; configurable via policy)
    "daemon.start": "boss",
    "daemon.stop": "boss",
    "agent.register": "boss",
    "agent.list": "restricted",
    "agent.bind": "privileged",
    "agent.unbind": "privileged",
    "agent.refresh": "boss",
    "agent.set": "privileged",
    "agent.session-policy.set": "privileged",
    "agent.background": "standard",
  },
};
