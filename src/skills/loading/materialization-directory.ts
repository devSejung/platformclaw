import fs from "node:fs/promises";
import path from "node:path";

async function ensureOwnerAccessibleDirectories(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return;
  }

  if ((stats.mode & 0o700) !== 0o700) {
    await fs.chmod(directory, stats.mode | 0o700);
  }
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await ensureOwnerAccessibleDirectories(path.join(directory, entry.name));
    }
  }
}

export async function normalizeSkillMaterializationDirectory(directory: string): Promise<void> {
  await ensureOwnerAccessibleDirectories(directory);
}

export async function prepareSkillMaterializationDirectory(directory: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await fs.mkdir(directory, { recursive: true });
    return;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    return;
  }

  // Materialized copies may inherit read-only source directory modes. Repair the
  // Gateway-owned cache before refresh so dotfiles and nested content remain replaceable.
  await ensureOwnerAccessibleDirectories(directory);
  for (const entry of await fs.readdir(directory)) {
    await fs.rm(path.join(directory, entry), { recursive: true, force: true });
  }
}
