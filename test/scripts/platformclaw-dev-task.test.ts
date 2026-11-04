import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const script = fileURLToPath(new URL("../../scripts/platformclaw-dev-task.mjs", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function createRepository() {
  const root = realpathSync(tempDirs.make("platformclaw-dev-task-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "PlatformClaw Test");
  git(root, "config", "user.email", "test@platformclaw.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.hooksPath", path.join(root, ".git", "hooks"));
  writeFileSync(path.join(root, "source.txt"), "original\n");
  writeFileSync(path.join(root, ".gitignore"), "/.worktrees/\n/.artifacts/\n/ignored/\n");
  git(root, "add", "source.txt", ".gitignore");
  git(root, "commit", "--quiet", "-m", "task fixture");
  return root;
}

function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

function expectSuccess(result: ReturnType<typeof cli>) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function createTask(root: string, name: string, primary = root) {
  expectSuccess(cli(root, "create", name, "--branch", `fix/${name}`, "--ref", "HEAD"));
  const matches = readdirSync(path.join(primary, ".worktrees")).filter((entry) =>
    entry.startsWith(`dev-${name}-`),
  );
  expect(matches).toHaveLength(1);
  const [entry] = matches;
  if (!entry) {
    throw new Error("Managed task did not create its worktree");
  }
  return path.join(primary, ".worktrees", entry);
}

const workspaceLink = "packages/a/node_modules/b";
const workspaceLinkTarget = "../../b";

function materializeWorkspaceLink(root: string, target: string) {
  const link = path.join(root, workspaceLink);
  mkdirSync(path.dirname(link), { recursive: true });
  if (lstatSync(link, { throwIfNoEntry: false })) {
    rmSync(link);
  }
  if (process.platform === "win32") {
    writeFileSync(link, target);
  } else {
    symlinkSync(target, link, "dir");
  }
  return link;
}

function commitWorkspaceLink(root: string) {
  git(root, "config", "core.symlinks", process.platform === "win32" ? "false" : "true");
  materializeWorkspaceLink(root, workspaceLinkTarget);
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: workspaceLinkTarget,
  });
  expect(blob.status, `${blob.stdout}\n${blob.stderr}`).toBe(0);
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${blob.stdout.trim()},${workspaceLink}`,
  );
  git(root, "commit", "--quiet", "-m", "tracked workspace link fixture");
}

function observeChild(child: ChildProcess) {
  let output = "";
  const ready = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Task exited before readiness: ${output}`)));
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      const match = /DEV_TASK_CHILD=(\d+)\r?\n/u.exec(output);
      if (match) {
        resolve(Number(match[1]));
      }
    });
  });
  child.stderr?.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return { ready, exited };
}

function stopOwnedProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

describe("PlatformClaw developer task lifecycle", () => {
  it("bootstraps create, run, and finish with Node alone before any package installation", () => {
    const root = createRepository();
    const bootstrap = path.join(root, ".artifacts", "bootstrap", "platformclaw-dev-task.mjs");
    mkdirSync(path.dirname(bootstrap), { recursive: true });
    copyFileSync(script, bootstrap);
    const runBootstrap = (...args: string[]) =>
      spawnSync(process.execPath, [bootstrap, ...args], { cwd: root, encoding: "utf8" });

    expectSuccess(
      runBootstrap("create", "bootstrap", "--branch", "fix/bootstrap", "--ref", "HEAD"),
    );
    expectSuccess(
      runBootstrap("run", "bootstrap", "--", process.execPath, "-e", "process.exit(0)"),
    );
    expectSuccess(runBootstrap("finish", "bootstrap", "--apply"));

    expect(existsSync(path.join(root, "node_modules"))).toBe(false);
    expect(readdirSync(path.join(root, ".worktrees"))).toEqual([]);
    expect(git(root, "branch", "--show-current")).toBe("main");
  });

  it("shares the canonical registry from linked worktrees without changing the primary branch", () => {
    const root = createRepository();
    const first = createTask(root, "first");
    const second = createTask(first, "second", root);

    expect(path.dirname(second)).toBe(path.join(root, ".worktrees"));
    expect(git(root, "branch", "--show-current")).toBe("main");
    expect(git(first, "branch", "--show-current")).toBe("fix/first");
    const listing = cli(first, "list");
    expectSuccess(listing);
    expect(listing.stdout).toContain("first");
    expect(listing.stdout).toContain("second");
    expect(existsSync(path.join(first, ".git", "platformclaw-dev-resources.sqlite"))).toBe(false);
    expect(existsSync(path.join(root, ".git", "platformclaw-dev-resources.sqlite"))).toBe(true);
  });

  it.each([0, 23])(
    "cleans joined command scratch on exit %s while preserving the worktree",
    (exit) => {
      const root = createRepository();
      const workspace = createTask(root, "command");
      const result = cli(
        root,
        "run",
        "command",
        "--",
        process.execPath,
        "-e",
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          'const temporary = path.join(process.env.TMPDIR, "disposable.txt");',
          'fs.writeFileSync(temporary, "temporary proof source");',
          'console.log("DEV_TASK_OBSERVED=" + JSON.stringify({ cwd: process.cwd(), temporary,',
          "tmp: process.env.TMP, temp: process.env.TEMP, tmpdir: process.env.TMPDIR }));",
          `process.exit(${exit});`,
        ].join("\n"),
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exit);
      const match = /DEV_TASK_OBSERVED=(\{[^\r\n]+\})/u.exec(result.stdout);
      if (!match?.[1]) {
        throw new Error("Managed command did not report its scratch path");
      }
      const observed = JSON.parse(match[1]) as {
        cwd: string;
        temporary: string;
        tmp: string;
        temp: string;
        tmpdir: string;
      };
      expect(realpathSync(observed.cwd)).toBe(realpathSync(workspace));
      expect(observed.tmp).toBe(observed.tmpdir);
      expect(observed.temp).toBe(observed.tmpdir);
      expect(
        path.relative(path.join(root, ".artifacts", "dev-tasks"), observed.tmpdir),
      ).not.toMatch(/^\.\./u);
      expect(existsSync(observed.temporary)).toBe(false);
      expect(readFileSync(path.join(workspace, "source.txt"), "utf8")).toBe("original\n");
    },
  );

  it("previews completion without enrolling the task into automatic deletion", () => {
    const root = createRepository();
    const workspace = createTask(root, "preview");

    expectSuccess(cli(root, "finish", "preview"));
    expectSuccess(cli(root, "sweep", "--apply"));

    expect(existsSync(workspace)).toBe(true);
    expectSuccess(cli(root, "finish", "preview", "--apply"));
    expect(existsSync(workspace)).toBe(false);
    expect(git(root, "rev-parse", "fix/preview")).toBe(git(root, "rev-parse", "main"));
  });

  it.each(["tracked", "untracked", "ignored"] as const)(
    "preserves %s files and retries explicitly finished work only after the files are resolved",
    (kind) => {
      const root = createRepository();
      const workspace = createTask(root, "preserve");
      const relative =
        kind === "tracked" ? "source.txt" : kind === "ignored" ? "ignored/proof.txt" : "new.txt";
      const saved = path.join(workspace, relative);
      mkdirSync(path.dirname(saved), { recursive: true });
      writeFileSync(saved, "keep this developer work\n");

      expect(cli(root, "finish", "preserve", "--apply").status).not.toBe(0);
      cli(root, "sweep", "--apply");
      expect(readFileSync(saved, "utf8")).toBe("keep this developer work\n");

      if (kind === "tracked") {
        writeFileSync(saved, "original\n");
      } else {
        rmSync(kind === "ignored" ? path.dirname(saved) : saved, { recursive: true });
      }
      expectSuccess(cli(root, "sweep", "--apply"));
      expect(existsSync(workspace)).toBe(false);
      expect(git(root, "branch", "--show-current")).toBe("main");
    },
  );

  it.each(["--assume-unchanged", "--skip-worktree"] as const)(
    "preserves modified tracked content hidden by %s",
    (flag) => {
      const root = createRepository();
      const workspace = createTask(root, "hidden");
      const source = path.join(workspace, "source.txt");
      git(workspace, "update-index", flag, "source.txt");
      writeFileSync(source, "unique developer work hidden from git status\n");
      expect(git(workspace, "status", "--porcelain")).toBe("");

      expect(cli(root, "finish", "hidden", "--apply").status).not.toBe(0);
      expect(readFileSync(source, "utf8")).toBe("unique developer work hidden from git status\n");

      git(workspace, "update-index", flag.replace("--", "--no-"), "source.txt");
      writeFileSync(source, "original\n");
      expectSuccess(cli(root, "sweep", "--apply"));
      expect(existsSync(workspace)).toBe(false);
    },
  );

  it.each([false, true])(
    "compares canonical guarded workspace links to their tracked target (modified=%s)",
    (modified) => {
      const root = createRepository();
      commitWorkspaceLink(root);
      const workspace = createTask(root, "guarded");
      git(workspace, "update-index", "--skip-worktree", workspaceLink);
      const expectedTarget = modified ? "../../unique-developer-target" : workspaceLinkTarget;
      const link = materializeWorkspaceLink(workspace, expectedTarget);
      expect(git(workspace, "status", "--porcelain")).toBe("");

      const finished = cli(root, "finish", "guarded", "--apply");
      if (!modified) {
        expectSuccess(finished);
        expect(existsSync(workspace)).toBe(false);
        return;
      }
      expect(finished.status).not.toBe(0);
      expect(process.platform === "win32" ? readFileSync(link, "utf8") : readlinkSync(link)).toBe(
        expectedTarget,
      );
      git(workspace, "update-index", "--no-skip-worktree", workspaceLink);
      materializeWorkspaceLink(workspace, workspaceLinkTarget);
      expectSuccess(cli(root, "sweep", "--apply"));
      expect(existsSync(workspace)).toBe(false);
    },
  );

  it("refuses finish during a run and requires explicit recovery after controller loss", async () => {
    const root = createRepository();
    const workspace = createTask(root, "interrupted");
    const controller = spawn(
      process.execPath,
      [
        script,
        "run",
        "interrupted",
        "--",
        process.execPath,
        "-e",
        'console.log("DEV_TASK_CHILD=" + process.pid); setInterval(() => {}, 1000);',
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const observed = observeChild(controller);
    let commandPid: number | undefined;
    try {
      commandPid = await observed.ready;
      expect(cli(root, "finish", "interrupted", "--apply").status).not.toBe(0);
      stopOwnedProcess(controller.pid!);
      await observed.exited;
      stopOwnedProcess(commandPid);
      commandPid = undefined;

      cli(root, "sweep", "--apply");
      expect(existsSync(workspace)).toBe(true);
      expect(cli(root, "finish", "interrupted", "--apply").status).not.toBe(0);
      expect(cli(root, "recover", "interrupted").status).not.toBe(0);
      expectSuccess(cli(root, "recover", "interrupted", "--confirm-stopped"));
      expectSuccess(cli(root, "finish", "interrupted", "--apply"));
      expect(existsSync(workspace)).toBe(false);
    } finally {
      if (commandPid !== undefined) {
        stopOwnedProcess(commandPid);
      }
      if (
        controller.pid !== undefined &&
        controller.exitCode === null &&
        controller.signalCode === null
      ) {
        stopOwnedProcess(controller.pid);
      }
      await observed.exited;
    }
  });

  it("rejects traversal and does not follow a task scratch directory link", () => {
    const root = createRepository();
    expect(cli(root, "create", "../escape", "--branch", "fix/escape").status).not.toBe(0);
    const workspace = createTask(root, "linked");
    const taskRoot = path.join(root, ".artifacts", "dev-tasks");
    const folders = readdirSync(taskRoot);
    expect(folders).toHaveLength(1);
    const [folder] = folders;
    if (!folder) {
      throw new Error("Managed task did not create its scratch directory");
    }
    const scratch = path.join(taskRoot, folder);
    const outside = realpathSync(tempDirs.make("platformclaw-dev-task-outside-"));
    writeFileSync(path.join(outside, "important.txt"), "not task-owned\n");
    rmSync(scratch, { recursive: true, force: true });
    symlinkSync(outside, scratch, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(cli(root, "finish", "linked", "--apply").status).not.toBe(0);
      expect(readFileSync(path.join(outside, "important.txt"), "utf8")).toBe("not task-owned\n");
      expect(existsSync(workspace)).toBe(true);
    } finally {
      // Remove only this test's link before the shared temp tracker tears down its root.
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(["-t", "-qt", "-qo", "-qotag", "--tag=platformclaw:latest", "--output=type=registry"])(
    "rejects unmanaged image publication through %s before invoking Docker",
    (flag) => {
      const root = createRepository();
      createTask(root, "image-options");
      const result = cli(
        root,
        "image",
        "image-options",
        "proof",
        "--",
        flag,
        "platformclaw:latest",
        ".",
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Managed image builds own their tags and local output");
      expectSuccess(cli(root, "finish", "image-options", "--apply"));
    },
  );
});
