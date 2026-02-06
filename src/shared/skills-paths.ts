import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HIBOSS_SKILLS_DIRNAME = "skills";
const BUILTIN_SKILLS_DIRNAME = ".system";
const PROVIDER_STATE_DIRNAME = ".hiboss";
const MANAGED_SKILLS_MANIFEST_FILENAME = "skills-managed.json";

export function getHiBossSkillsDir(hibossDir: string): string {
  return path.join(hibossDir, HIBOSS_SKILLS_DIRNAME);
}

export function getHiBossBuiltinSkillsDir(hibossDir: string): string {
  return path.join(getHiBossSkillsDir(hibossDir), BUILTIN_SKILLS_DIRNAME);
}

export function getProviderSkillsDir(providerHomePath: string): string {
  return path.join(providerHomePath, HIBOSS_SKILLS_DIRNAME);
}

export function getProviderStateDir(providerHomePath: string): string {
  return path.join(providerHomePath, PROVIDER_STATE_DIRNAME);
}

export function getProviderManagedSkillsManifestPath(providerHomePath: string): string {
  return path.join(getProviderStateDir(providerHomePath), MANAGED_SKILLS_MANIFEST_FILENAME);
}

export function isReservedHiBossSkillsName(name: string): boolean {
  return name === BUILTIN_SKILLS_DIRNAME;
}

function findNearestPackageRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getBundledBuiltinSkillsDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findNearestPackageRoot(moduleDir);
  if (!packageRoot) {
    return null;
  }
  return path.join(packageRoot, HIBOSS_SKILLS_DIRNAME, BUILTIN_SKILLS_DIRNAME);
}

