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
export const DEFAULT_MODELS_DIRNAME = "models";

export function getDefaultHiBossDir(): string {
  return path.join(os.homedir(), DEFAULT_HIBOSS_DIRNAME);
}

export function getDefaultMediaDir(): string {
  return path.join(getDefaultHiBossDir(), DEFAULT_MEDIA_DIRNAME);
}

export function getDefaultModelsDir(): string {
  return path.join(getDefaultHiBossDir(), DEFAULT_MODELS_DIRNAME);
}

// ==================== Memory Defaults ====================

export const DEFAULT_MEMORY_TOTAL_MAX_CHARS = 20_000 as const;
export const DEFAULT_MEMORY_LONGTERM_MAX_CHARS = 12_000 as const;
export const DEFAULT_MEMORY_SHORTTERM_MAX_CHARS = 8_000 as const;
export const DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS = 4_000 as const;
export const DEFAULT_MEMORY_SHORTTERM_DAYS = 2 as const;

export const DEFAULT_INTERNAL_SPACE_NOTE_MAX_CHARS = 12_000 as const;

export const DEFAULT_MEMORY_MODEL_URL =
  "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf?download=true" as const;

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

    // Backwards-compatible aliases
    "message.send": "restricted",
    "message.list": "restricted",

    // Reactions
    "reaction.set": "restricted",

    // Cron schedules
    "cron.create": "restricted",
    "cron.list": "restricted",
    "cron.enable": "restricted",
    "cron.disable": "restricted",
    "cron.delete": "restricted",

    // Semantic memory
    "memory.add": "restricted",
    "memory.search": "restricted",
    "memory.list": "restricted",
    "memory.categories": "restricted",
    "memory.delete-category": "restricted",
    "memory.get": "restricted",
    "memory.delete": "restricted",
    "memory.clear": "standard",
    "memory.setup": "privileged",

    // Daemon read-only
    "daemon.status": "boss",
    "daemon.ping": "standard",

    // Admin operations (boss-only by default; configurable via policy)
    "daemon.start": "boss",
    "daemon.stop": "boss",
    "agent.register": "boss",
    "agent.list": "restricted",
    "agent.status": "restricted",
    "agent.bind": "privileged",
    "agent.unbind": "privileged",
    "agent.refresh": "boss",
    "agent.delete": "boss",
    "agent.set": "privileged",
    "agent.session-policy.set": "privileged",
  },
};
