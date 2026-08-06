import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../..");

export function resolveRepoPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || isAbsolute(normalized)) {
    throw new Error(`unsafe repository path: ${relativePath}`);
  }
  const absolutePath = resolve(repoRoot, normalized);
  const relation = relative(repoRoot, absolutePath);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`unsafe repository path: ${relativePath}`);
  }
  return absolutePath;
}

export function requirePath(relativePath) {
  const absolutePath = resolveRepoPath(relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`missing required path: ${relativePath}`);
  }
  return absolutePath;
}

export function readText(relativePath) {
  return readFileSync(requirePath(relativePath), "utf8");
}

export function readJsonYaml(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    throw new Error(`${relativePath} must contain JSON-compatible YAML`, { cause: error });
  }
}

export function listFiles(relativePath) {
  const absolutePath = requirePath(relativePath);
  if (!statSync(absolutePath).isDirectory()) {
    return [relativePath.replaceAll("\\", "/")];
  }
  const output = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const childPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(childPath, childPrefix);
      } else if (entry.isFile()) {
        output.push(`${relativePath.replaceAll("\\", "/")}/${childPrefix}`);
      }
    }
  };
  visit(absolutePath, "");
  return output.toSorted((left, right) => left.localeCompare(right));
}

export function runNodeScript(relativePath, args = []) {
  const result = spawnSync(process.execPath, [relativePath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${relativePath} failed with exit code ${String(result.status)}`);
  }
}

export function runCommand(executable, args) {
  try {
    return execFileSync(executable, args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`${executable} ${args.join(" ")} failed`, { cause: error });
  }
}

export function printSuccess(label, details = "") {
  process.stdout.write(`[submission] PASS ${label}${details ? `: ${details}` : ""}\n`);
}
