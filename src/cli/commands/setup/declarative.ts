import * as fs from "node:fs";
import * as path from "node:path";

import { getDefaultConfig, isDaemonRunning } from "../../../daemon/daemon.js";
import { HiBossDatabase } from "../../../daemon/db/database.js";
import { setupAgentHome } from "../../../agent/home-setup.js";
import type {
  SetupDeclarativeConfig,
  SetupDeclarativeAgentConfig,
  SetupDeclarativeProjectConfig,
  SetupReconcileResult,
} from "./types.js";
import type { AgentRole } from "../../../shared/agent-role.js";
import { resolveAgentRole, AGENT_ROLES } from "../../../shared/agent-role.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../../shared/validation.js";
import {
  BACKGROUND_AGENT_NAME,
  DEFAULT_SETUP_AGENT_NAME,
  DEFAULT_SETUP_PERMISSION_LEVEL,
  getDefaultAgentDescription,
  getDefaultSetupBossName,
  getDefaultSetupWorkspace,
} from "../../../shared/defaults.js";
import { getDaemonIanaTimeZone, isValidIanaTimeZone } from "../../../shared/timezone.js";
import { getSpeakerBindingIntegrity } from "../../../shared/speaker-binding-invariant.js";
import { isPermissionLevel } from "../../../shared/permissions.js";
import { SUPPORTED_ADAPTER_TYPES } from "../../../adapters/registry.js";

function ensureBossProfileFile(hibossDir: string): void {
  try {
    const bossMdPath = path.join(hibossDir, "BOSS.md");
    if (!fs.existsSync(bossMdPath)) {
      fs.writeFileSync(bossMdPath, "", "utf8");
      return;
    }
    const stat = fs.statSync(bossMdPath);
    if (!stat.isFile()) {
      return;
    }
  } catch {
    // Best-effort; don't fail setup on customization file issues.
  }
}

function sanitizeMetadataForSetupConfig(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata || Array.isArray(metadata)) return undefined;
  const copy = { ...metadata };
  delete copy.role;
  delete copy.sessionHandle;
  return Object.keys(copy).length > 0 ? copy : undefined;
}

function buildDefaultDeclarativeConfig(): SetupDeclarativeConfig {
  const workspace = getDefaultSetupWorkspace();
  return {
    version: 2,
    bossName: getDefaultSetupBossName(),
    bossTimezone: getDaemonIanaTimeZone(),
    adapterBossIds: {
      telegram: "",
    },
    agents: [
      {
        name: DEFAULT_SETUP_AGENT_NAME,
        role: "speaker",
        provider: "claude",
        description: getDefaultAgentDescription(DEFAULT_SETUP_AGENT_NAME),
        workspace,
        model: null,
        reasoningEffort: null,
        permissionLevel: DEFAULT_SETUP_PERMISSION_LEVEL,
        bindings: [
          {
            adapterType: "telegram",
            adapterToken: "123456789:REPLACE_ME",
          },
        ],
      },
      {
        name: "kai",
        role: "leader",
        provider: "claude",
        description: getDefaultAgentDescription("kai"),
        workspace,
        model: null,
        reasoningEffort: null,
        permissionLevel: DEFAULT_SETUP_PERMISSION_LEVEL,
        bindings: [],
      },
    ],
    projects: [],
  };
}

export async function exportSetupConfig(): Promise<SetupDeclarativeConfig> {
  const daemonConfig = getDefaultConfig();
  const dbPath = path.join(daemonConfig.daemonDir, "hiboss.db");

  if (!fs.existsSync(dbPath)) {
    return buildDefaultDeclarativeConfig();
  }

  const db = new HiBossDatabase(dbPath);
  try {
    const allBindings = db.listBindings();
    const requiredAdapterTypes = new Set(allBindings.map((binding) => binding.adapterType));
    const adapterBossIds: Record<string, string> = {};
    for (const adapterType of SUPPORTED_ADAPTER_TYPES) {
      const bossId = (db.getAdapterBossId(adapterType) ?? "").trim();
      if (bossId) {
        adapterBossIds[adapterType] = bossId;
      }
    }
    for (const adapterType of requiredAdapterTypes) {
      if (adapterBossIds[adapterType]) {
        continue;
      }
      const bossId = (db.getAdapterBossId(adapterType) ?? "").trim();
      if (bossId) {
        adapterBossIds[adapterType] = bossId;
      }
    }
    const bindingCountByAgent = new Map<string, number>();
    for (const binding of allBindings) {
      bindingCountByAgent.set(binding.agentName, (bindingCountByAgent.get(binding.agentName) ?? 0) + 1);
    }

    const agents = db
      .listAgents()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map<SetupDeclarativeAgentConfig>((agent) => {
        const role = resolveAgentRole({
          metadata: agent.metadata,
          bindingCount: bindingCountByAgent.get(agent.name) ?? 0,
        });

        const bindings = allBindings
          .filter((binding) => binding.agentName === agent.name)
          .sort((a, b) => {
            if (a.adapterType !== b.adapterType) return a.adapterType.localeCompare(b.adapterType);
            return a.adapterToken.localeCompare(b.adapterToken);
          })
          .map((binding) => ({
            adapterType: binding.adapterType,
            adapterToken: binding.adapterToken,
          }));

        return {
          name: agent.name,
          role,
          provider: agent.provider ?? "claude",
          description: agent.description ?? getDefaultAgentDescription(agent.name),
          workspace: agent.workspace ?? getDefaultSetupWorkspace(),
          model: agent.model ?? null,
          reasoningEffort: agent.reasoningEffort ?? null,
          permissionLevel: agent.permissionLevel ?? DEFAULT_SETUP_PERMISSION_LEVEL,
          sessionPolicy: agent.sessionPolicy,
          metadata: sanitizeMetadataForSetupConfig(agent.metadata),
          bindings,
        };
      });

    const projects = db
      .listProjects({ limit: 2000 })
      .sort((a, b) => a.id.localeCompare(b.id))
      .map<SetupDeclarativeProjectConfig>((project) => ({
        id: project.id,
        name: project.name,
        root: project.root,
        speakerAgent: project.speakerAgent,
        mainGroupChannel: project.mainGroupChannel,
        leaders: (project.leaders ?? [])
          .slice()
          .sort((a, b) => a.agentName.localeCompare(b.agentName))
          .map((leader) => ({
            agentName: leader.agentName,
            capabilities: leader.capabilities.length > 0 ? leader.capabilities : undefined,
            active: leader.active,
          })),
      }));

    if (agents.length === 0) {
      return {
        ...buildDefaultDeclarativeConfig(),
        bossName: (db.getBossName() ?? "").trim() || getDefaultSetupBossName(),
        bossTimezone: (db.getConfig("boss_timezone") ?? "").trim() || getDaemonIanaTimeZone(),
        adapterBossIds,
        projects,
      };
    }

    return {
      version: 2,
      bossName: (db.getBossName() ?? "").trim() || getDefaultSetupBossName(),
      bossTimezone: (db.getConfig("boss_timezone") ?? "").trim() || getDaemonIanaTimeZone(),
      adapterBossIds,
      agents,
      projects,
    };
  } finally {
    db.close();
  }
}

function assertDeclarativeConfig(config: SetupDeclarativeConfig): void {
  if (config.version !== 2) {
    throw new Error("Invalid setup config version (expected 2)");
  }

  if (!config.bossName.trim()) {
    throw new Error("Invalid setup config (boss-name is required)");
  }

  if (!config.bossTimezone.trim() || !isValidIanaTimeZone(config.bossTimezone.trim())) {
    throw new Error("Invalid setup config (boss-timezone must be a valid IANA timezone)");
  }

  if (
    typeof config.adapterBossIds !== "object" ||
    config.adapterBossIds === null ||
    Array.isArray(config.adapterBossIds)
  ) {
    throw new Error("Invalid setup config (adapters must be an object)");
  }

  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error("Invalid setup config (agents must contain at least one agent)");
  }

  const normalizedRoles = new Set<string>();
  const seenNames = new Set<string>();
  const roleByAgentName = new Map<string, AgentRole>();
  const allBindings: Array<{ agentName: string; adapterType: string; adapterToken: string }> = [];
  const adapterIdentitySet = new Set<string>();

  for (const agent of config.agents) {
    const trimmedName = agent.name.trim();
    if (!isValidAgentName(trimmedName)) {
      throw new Error(`Invalid setup config (agent.name): ${AGENT_NAME_ERROR_MESSAGE}`);
    }
    if (trimmedName.toLowerCase() === BACKGROUND_AGENT_NAME) {
      throw new Error(`Invalid setup config (agent.name): reserved name '${BACKGROUND_AGENT_NAME}'`);
    }

    const lowered = trimmedName.toLowerCase();
    if (seenNames.has(lowered)) {
      throw new Error(`Invalid setup config (duplicate agent name): ${trimmedName}`);
    }
    seenNames.add(lowered);
    roleByAgentName.set(lowered, agent.role);

    if (!AGENT_ROLES.includes(agent.role)) {
      throw new Error("Invalid setup config (agent.role must be speaker or leader)");
    }
    normalizedRoles.add(agent.role);

    if (agent.provider !== "claude" && agent.provider !== "codex") {
      throw new Error(`Invalid setup config (agent.provider for '${trimmedName}')`);
    }

    if (!agent.workspace.trim() || !path.isAbsolute(agent.workspace.trim())) {
      throw new Error(`Invalid setup config (agent.workspace for '${trimmedName}' must be an absolute path)`);
    }

    if (agent.permissionLevel !== undefined && !isPermissionLevel(agent.permissionLevel)) {
      throw new Error(`Invalid setup config (agent.permission-level for '${trimmedName}')`);
    }

    if (!Array.isArray(agent.bindings)) {
      throw new Error(`Invalid setup config (agent.bindings for '${trimmedName}' must be an array)`);
    }

    const seenTypesForAgent = new Set<string>();
    for (const binding of agent.bindings) {
      const adapterType = binding.adapterType.trim();
      const adapterToken = binding.adapterToken.trim();
      if (!adapterType) {
        throw new Error(`Invalid setup config (binding.adapter-type for '${trimmedName}' is required)`);
      }
      if (!adapterToken) {
        throw new Error(`Invalid setup config (binding.adapter-token for '${trimmedName}' is required)`);
      }
      if (adapterType === "telegram" && !/^\d+:[A-Za-z0-9_-]+$/.test(adapterToken)) {
        throw new Error(`Invalid setup config (telegram adapter token for '${trimmedName}' has invalid format)`);
      }
      if (seenTypesForAgent.has(adapterType)) {
        throw new Error(`Invalid setup config (duplicate ${adapterType} binding for '${trimmedName}')`);
      }

      const adapterIdentity = `${adapterType}\u0000${adapterToken}`;
      if (adapterIdentitySet.has(adapterIdentity)) {
        throw new Error(
          `Invalid setup config (duplicate adapter binding): ${adapterType} token reused across agents`
        );
      }

      seenTypesForAgent.add(adapterType);
      adapterIdentitySet.add(adapterIdentity);
      allBindings.push({ agentName: trimmedName, adapterType, adapterToken });
    }
  }

  if (!normalizedRoles.has("speaker") || !normalizedRoles.has("leader")) {
    throw new Error("Invalid setup config (requires at least one speaker and one leader)");
  }

  const integrity = getSpeakerBindingIntegrity({
    agents: config.agents.map((agent) => ({
      name: agent.name,
      metadata: { role: agent.role },
    })),
    bindings: allBindings,
  });

  if (integrity.speakerWithoutBindings.length > 0) {
    throw new Error(
      `Invalid setup config (speaker must bind at least one adapter): ${integrity.speakerWithoutBindings.join(", ")}`
    );
  }

  if (integrity.duplicateSpeakerBindings.length > 0) {
    const duplicate = integrity.duplicateSpeakerBindings[0]!;
    throw new Error(
      `Invalid setup config (duplicate speaker binding): ${duplicate.adapterType} token reused by ${duplicate.speakers.join(", ")}`
    );
  }

  const requiredAdapterTypes = new Set(allBindings.map((binding) => binding.adapterType));
  for (const adapterType of requiredAdapterTypes) {
    const adapterBossIdRaw = config.adapterBossIds[adapterType];
    const adapterBossId = typeof adapterBossIdRaw === "string" ? adapterBossIdRaw.trim() : "";
    if (!adapterBossId) {
      throw new Error(`Invalid setup config (${adapterType}.adapter-boss-id is required)`);
    }
  }

  if (config.projects === undefined) {
    return;
  }
  if (!Array.isArray(config.projects)) {
    throw new Error("Invalid setup config (projects must be an array when provided)");
  }

  const seenProjectIds = new Set<string>();
  const seenProjectRoots = new Set<string>();
  for (const project of config.projects) {
    const projectId = project.id.trim();
    if (!projectId) {
      throw new Error("Invalid setup config (project.id is required)");
    }

    const normalizedProjectId = projectId.toLowerCase();
    if (seenProjectIds.has(normalizedProjectId)) {
      throw new Error(`Invalid setup config (duplicate project id): ${projectId}`);
    }
    seenProjectIds.add(normalizedProjectId);

    if (!project.name.trim()) {
      throw new Error(`Invalid setup config (project.name is required for '${projectId}')`);
    }

    const projectRoot = project.root.trim();
    if (!projectRoot || !path.isAbsolute(projectRoot)) {
      throw new Error(`Invalid setup config (project.root for '${projectId}' must be an absolute path)`);
    }
    const normalizedRoot = process.platform === "linux" ? projectRoot : projectRoot.toLowerCase();
    if (seenProjectRoots.has(normalizedRoot)) {
      throw new Error(`Invalid setup config (duplicate project root): ${projectRoot}`);
    }
    seenProjectRoots.add(normalizedRoot);

    const speakerName = project.speakerAgent.trim();
    const speakerRole = roleByAgentName.get(speakerName.toLowerCase());
    if (speakerRole !== "speaker") {
      throw new Error(
        `Invalid setup config (project.speaker-agent for '${projectId}' must reference an existing speaker agent)`
      );
    }

    if (!Array.isArray(project.leaders)) {
      throw new Error(`Invalid setup config (project.leaders for '${projectId}' must be an array)`);
    }

    const seenProjectLeaderNames = new Set<string>();
    for (const leader of project.leaders) {
      const leaderName = leader.agentName.trim();
      if (!leaderName) {
        throw new Error(`Invalid setup config (project.leader.agent-name for '${projectId}' is required)`);
      }
      const normalizedLeaderName = leaderName.toLowerCase();
      if (seenProjectLeaderNames.has(normalizedLeaderName)) {
        throw new Error(`Invalid setup config (duplicate project leader '${leaderName}' for '${projectId}')`);
      }
      seenProjectLeaderNames.add(normalizedLeaderName);

      const leaderRole = roleByAgentName.get(normalizedLeaderName);
      if (leaderRole !== "leader") {
        throw new Error(
          `Invalid setup config (project leader '${leaderName}' for '${projectId}' must reference an existing leader agent)`
        );
      }

      if (leader.capabilities !== undefined) {
        if (!Array.isArray(leader.capabilities) || leader.capabilities.some((capability) => !capability.trim())) {
          throw new Error(
            `Invalid setup config (project leader capabilities for '${projectId}' must be non-empty strings)`
          );
        }
      }
    }
  }
}

function requireSetupMutationToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length < 4) {
    throw new Error("Invalid boss token (must be at least 4 characters)");
  }
  return trimmed;
}

export async function reconcileSetupConfig(params: {
  config: SetupDeclarativeConfig;
  token: string;
  dryRun: boolean;
  sourcePath?: string;
  sourceFingerprint?: string;
}): Promise<SetupReconcileResult> {
  assertDeclarativeConfig(params.config);

  if (await isDaemonRunning()) {
    throw new Error("Daemon is running. Stop it first: hiboss daemon stop --token <boss-token>");
  }

  const daemonConfig = getDefaultConfig();
  fs.mkdirSync(daemonConfig.dataDir, { recursive: true });
  fs.mkdirSync(daemonConfig.daemonDir, { recursive: true });

  const dbPath = path.join(daemonConfig.daemonDir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);

  try {
    const token = requireSetupMutationToken(params.token);
    const hasBossToken = Boolean((db.getConfig("boss_token_hash") ?? "").trim());
    if (hasBossToken && !db.verifyBossToken(token)) {
      throw new Error("Invalid boss token");
    }

    const currentAgents = db.listAgents().map((agent) => agent.name).sort((a, b) => a.localeCompare(b));
    const desiredAgents = [...params.config.agents]
      .map((agent) => agent.name.trim())
      .sort((a, b) => a.localeCompare(b));

    const currentLower = new Set(currentAgents.map((name) => name.toLowerCase()));
    const desiredLower = new Set(desiredAgents.map((name) => name.toLowerCase()));

    const removedAgentNames = currentAgents.filter((name) => !desiredLower.has(name.toLowerCase()));
    const recreatedAgentNames = desiredAgents.filter((name) => currentLower.has(name.toLowerCase()));
    const newlyCreatedAgentNames = desiredAgents.filter((name) => !currentLower.has(name.toLowerCase()));

    const diff = {
      firstApply: !db.isSetupComplete(),
      currentAgentNames: currentAgents,
      desiredAgentNames: desiredAgents,
      removedAgentNames,
      recreatedAgentNames,
      newlyCreatedAgentNames,
      currentBindingCount: db.listBindings().length,
      desiredBindingCount: params.config.agents.reduce((sum, agent) => sum + agent.bindings.length, 0),
    };

    if (params.dryRun) {
      return {
        dryRun: true,
        diff,
        generatedAgentTokens: [],
      };
    }

    for (const agent of params.config.agents) {
      await setupAgentHome(agent.name, daemonConfig.dataDir);
    }
    ensureBossProfileFile(daemonConfig.dataDir);

    const generatedAgentTokens = db.runInTransaction(() => {
      db.clearSetupManagedState();
      if (params.config.projects !== undefined) {
        db.clearProjectCatalogState();
      }
      db.setBossName(params.config.bossName.trim());
      db.setConfig("boss_timezone", params.config.bossTimezone.trim());
      for (const [adapterType, rawBossId] of Object.entries(params.config.adapterBossIds)) {
        const normalizedBossId = rawBossId.trim();
        if (!normalizedBossId) {
          continue;
        }
        db.setAdapterBossId(
          adapterType,
          adapterType === "telegram" ? normalizedBossId.replace(/^@/, "") : normalizedBossId
        );
      }
      db.setBossToken(token);
      if (typeof params.sourcePath === "string" && params.sourcePath.trim()) {
        db.setConfig("setup_config_file", params.sourcePath.trim());
      }
      if (typeof params.sourceFingerprint === "string" && params.sourceFingerprint.trim()) {
        db.setConfig("setup_config_fingerprint", params.sourceFingerprint.trim());
      }

      const tokens: Array<{ name: string; role: AgentRole; token: string }> = [];
      for (const agent of params.config.agents) {
        const registered = db.registerAgent({
          name: agent.name.trim(),
          role: agent.role,
          description: agent.description,
          workspace: agent.workspace,
          provider: agent.provider,
          model: agent.model,
          reasoningEffort: agent.reasoningEffort,
          permissionLevel: agent.permissionLevel,
          sessionPolicy: agent.sessionPolicy,
          metadata: sanitizeMetadataForSetupConfig(agent.metadata),
        });

        tokens.push({
          name: registered.agent.name,
          role: agent.role,
          token: registered.token,
        });

        for (const binding of agent.bindings) {
          db.createBinding(agent.name.trim(), binding.adapterType.trim(), binding.adapterToken.trim());
        }
      }

      if (params.config.projects !== undefined) {
        for (const project of params.config.projects) {
          const projectId = project.id.trim();
          db.upsertProject({
            id: projectId,
            name: project.name.trim(),
            root: project.root.trim(),
            speakerAgent: project.speakerAgent.trim(),
            mainGroupChannel: project.mainGroupChannel?.trim() || undefined,
          });

          for (const leader of project.leaders) {
            db.upsertProjectLeader({
              projectId,
              agentName: leader.agentName.trim(),
              capabilities: (leader.capabilities ?? []).map((capability) => capability.trim()),
              active: leader.active ?? true,
            });
          }
        }
      }

      db.markSetupComplete();
      return tokens;
    });

    return {
      dryRun: false,
      diff,
      generatedAgentTokens,
    };
  } finally {
    db.close();
  }
}
