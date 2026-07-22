import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkGuard,
  installGuard,
  removeGuard,
} from "../scripts/platformclaw-windows-git-guard.mjs";

const cleanupPaths: string[] = [];

function git(repoRoot: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function createFixture(): { linkPath: string; repoRoot: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "platformclaw-git-guard-"));
  cleanupPaths.push(repoRoot);
  git(repoRoot, ["init", "--quiet"]);
  git(repoRoot, ["config", "user.email", "test@example.invalid"]);
  git(repoRoot, ["config", "user.name", "PlatformClaw Test"]);
  writeFileSync(path.join(repoRoot, "sentinel.txt"), "original\n");
  git(repoRoot, ["add", "sentinel.txt"]);
  git(repoRoot, ["commit", "--quiet", "-m", "initial"]);

  const linkName = "packages/example/node_modules/openclaw";
  const objectId = git(repoRoot, ["hash-object", "-w", "--stdin"], ".\n").trim();
  git(repoRoot, ["update-index", "--add", "--cacheinfo", `120000,${objectId},${linkName}`]);
  git(repoRoot, ["commit", "--quiet", "-m", "tracked workspace link"]);

  const linkPath = path.join(repoRoot, ...linkName.split("/"));
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(repoRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
  return { linkPath, repoRoot };
}

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    rmSync(cleanupPath, { force: true, recursive: true });
  }
});

describe("PlatformClaw Windows Git junction guard", () => {
  it("protects a tracked workspace junction during git stash", () => {
    const { linkPath, repoRoot } = createFixture();
    expect(installGuard(repoRoot)).toEqual(["packages/example/node_modules/openclaw"]);
    expect(checkGuard(repoRoot)).toEqual(["packages/example/node_modules/openclaw"]);

    writeFileSync(path.join(repoRoot, "sentinel.txt"), "changed\n");
    git(repoRoot, ["stash", "push", "--quiet"]);

    expect(existsSync(path.join(repoRoot, ".git", "HEAD"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "sentinel.txt"))).toBe(true);
    expect(existsSync(linkPath)).toBe(true);
  });

  it("refuses to remove protection from a live Windows junction", () => {
    const { repoRoot } = createFixture();
    installGuard(repoRoot);

    expect(() => removeGuard(repoRoot, "win32")).toThrow(
      "refusing to remove guard while Windows links or junctions exist",
    );
  });

  it("rejects a protected workspace link staged for deletion", () => {
    const { repoRoot } = createFixture();
    git(repoRoot, ["update-index", "--force-remove", "packages/example/node_modules/openclaw"]);

    expect(() => installGuard(repoRoot)).toThrow(
      "refusing to change guard while HEAD and index differ",
    );
  });

  it("recognizes protection when assume-unchanged is also set", () => {
    const { repoRoot } = createFixture();
    git(repoRoot, ["update-index", "--assume-unchanged", "packages/example/node_modules/openclaw"]);

    installGuard(repoRoot);
    expect(checkGuard(repoRoot)).toEqual(["packages/example/node_modules/openclaw"]);
  });
});
