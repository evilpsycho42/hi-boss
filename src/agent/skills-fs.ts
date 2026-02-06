import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sortedDirectoryEntries(dirPath: string): fs.Dirent[] {
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  hash.update("file\n");

  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest("hex");
}

function hashSymlink(linkPath: string): string {
  const hash = createHash("sha256");
  hash.update("symlink\n");
  hash.update(fs.readlinkSync(linkPath), "utf8");
  return hash.digest("hex");
}

function hashDirectory(dirPath: string): string {
  const hash = createHash("sha256");
  hash.update("dir\n");
  for (const entry of sortedDirectoryEntries(dirPath)) {
    const fullPath = path.join(dirPath, entry.name);
    hash.update(entry.name, "utf8");
    hash.update("\n");

    const stat = fs.lstatSync(fullPath);
    if (stat.isDirectory()) {
      hash.update(hashDirectory(fullPath), "utf8");
      continue;
    }
    if (stat.isSymbolicLink()) {
      hash.update(hashSymlink(fullPath), "utf8");
      continue;
    }

    if (stat.isFile()) {
      hash.update(hashFile(fullPath), "utf8");
      continue;
    }

    hash.update(hashSpecialEntry(fullPath, stat), "utf8");
  }
  return hash.digest("hex");
}

function hashSpecialEntry(entryPath: string, stat: fs.Stats): string {
  const hash = createHash("sha256");
  hash.update("special\n");
  hash.update(entryPath, "utf8");
  hash.update("\n");
  hash.update(String(stat.mode), "utf8");
  hash.update("\n");
  hash.update(String(stat.dev), "utf8");
  hash.update("\n");
  hash.update(String(stat.ino), "utf8");
  hash.update("\n");
  hash.update(String(stat.rdev), "utf8");
  hash.update("\n");
  hash.update(String(stat.size), "utf8");
  return hash.digest("hex");
}

export function hashEntry(entryPath: string): string {
  const stat = fs.lstatSync(entryPath);
  if (stat.isDirectory()) {
    return hashDirectory(entryPath);
  }
  if (stat.isSymbolicLink()) {
    return hashSymlink(entryPath);
  }
  if (!stat.isFile()) {
    return hashSpecialEntry(entryPath, stat);
  }
  return hashFile(entryPath);
}

export function listTopLevelEntries(dirPath: string): Array<{ name: string; absolutePath: string }> {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const result: Array<{ name: string; absolutePath: string }> = [];
  for (const entry of sortedDirectoryEntries(dirPath)) {
    result.push({ name: entry.name, absolutePath: path.join(dirPath, entry.name) });
  }
  return result;
}

export function removeEntry(entryPath: string): void {
  if (!fs.existsSync(entryPath)) {
    return;
  }
  fs.rmSync(entryPath, { recursive: true, force: true });
}

export function replaceEntry(srcPath: string, destPath: string): void {
  removeEntry(destPath);
  const parentDir = path.dirname(destPath);
  ensureDir(parentDir);
  fs.cpSync(srcPath, destPath, { recursive: true, force: true });
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const parentDir = path.dirname(filePath);
  ensureDir(parentDir);

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const json = JSON.stringify(value, null, 2) + "\n";

  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function ensureDirectory(dirPath: string): void {
  ensureDir(dirPath);
}
