#!/usr/bin/env node

// Development-only resource ownership. Product runtime databases are never opened here.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

function command(executable, args, cwd = process.cwd()) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message || result.stderr.trim() || `${executable} failed (${result.status})`,
    );
  }
  return result.stdout.trim();
}

function primaryRoot(cwd) {
  const common = realpathSync(
    command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
  );
  if (basename(common) !== ".git") {
    throw new Error(
      "Use a normal primary checkout or its linked worktree (bare repositories are unsupported)",
    );
  }
  return dirname(common);
}

let root;
let databasePath;
let database;

function openRegistry() {
  if (database) {
    return;
  }
  // Bootstrap-only SQLite primitive: workspace setup/cleanup must work before
  // package installation. Fixed parameterized operations below never access
  // product databases or introduce a second runtime persistence path.
  safePath(databasePath);
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS dev_tasks (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      start_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'running', 'incomplete', 'finished', 'cleaned')),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      docker_engine TEXT
    );
  `);
}

function tasks() {
  openRegistry();
  return database.prepare("SELECT * FROM dev_tasks ORDER BY created_at").all();
}

function taskByName(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(name ?? "")) {
    throw new Error("Task name must contain 1–48 lowercase letters, digits, or hyphens");
  }
  openRegistry();
  const task = database.prepare("SELECT * FROM dev_tasks WHERE name = ?").get(name);
  if (!task) {
    throw new Error(`Unknown task: ${name}`);
  }
  return task;
}

function update(task, values) {
  // A command may have already recorded its Docker engine. Reread under the
  // task lock so a later state-only update cannot erase that ownership fact.
  const current = taskByName(task.name);
  if (current.token !== task.token) {
    throw new Error("Task ownership changed; refusing registry update");
  }
  database
    .prepare(
      "UPDATE dev_tasks SET state = ?, note = ?, docker_engine = ? WHERE name = ? AND token = ?",
    )
    .run(
      values.state ?? current.state,
      values.note ?? current.note,
      values.docker_engine ?? current.docker_engine,
      task.name,
      task.token,
    );
}

function paths(task) {
  if (!/^[0-9a-f]{32}$/u.test(task.token) || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(task.name)) {
    throw new Error("Invalid task identity in developer registry; refusing cleanup");
  }
  return {
    workspace: join(root, ".worktrees", `dev-${task.name}-${task.token.slice(0, 8)}`),
    scratch: join(root, ".artifacts", "dev-tasks", task.token),
    repository: `platformclaw-dev-${task.token}`,
  };
}

function safePath(target) {
  const local = relative(root, target);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || resolve(root, local) !== target) {
    throw new Error(`Refusing path outside the managed checkout: ${target}`);
  }
  let cursor = root;
  for (const part of local.split(sep)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing managed path through a symlink/junction: ${cursor}`);
    }
  }
}

async function locked(name, action) {
  const key = createHash("sha256").update(`${root}\0${name}`).digest("hex");
  // OS-owned endpoints disappear with the controller, without stale PID files
  // or collision-prone TCP ports in the host's outbound ephemeral range.
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\platformclaw-dev-${key}`
      : `\0platformclaw-dev-${key}`;
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error("Managed tasks require Windows or Linux; use local Docker/WSL on other hosts");
  }
  const server = createServer();
  try {
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen({ path, exclusive: true }, accept);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new Error(`Task ${name} is busy; run/image/finish/sweep never overlap`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await new Promise((accept, reject) => {
      server.close((error) =>
        error
          ? reject(new Error("Failed to release developer task lock", { cause: error }))
          : accept(),
      );
    });
  }
}

function assertUsable(task) {
  if (task.state !== "active") {
    throw new Error(
      `Task ${task.name} is ${task.state}: ${task.note}. Inspect list; interrupted commands require recover --confirm-stopped.`,
    );
  }
  const { workspace } = paths(task);
  safePath(workspace);
  if (
    realpathSync(command("git", ["rev-parse", "--show-toplevel"], workspace)) !== workspace ||
    primaryRoot(workspace) !== root
  ) {
    throw new Error("Task workspace no longer belongs to this checkout");
  }
}

function scratchCleanup(task, apply) {
  const { scratch } = paths(task);
  safePath(scratch);
  console.log(`${apply ? "APPLY" : "PREVIEW"}: remove task scratch ${scratch}`);
  if (apply) {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function taskEnvironment(task) {
  const { scratch, repository } = paths(task);
  safePath(scratch);
  const tmp = join(scratch, "tmp");
  mkdirSync(tmp, { recursive: true });
  return {
    ...process.env,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    PLATFORMCLAW_DEV_IMAGE_REPOSITORY: repository,
  };
}

function assertVisibleIndex(workspace) {
  const entries = command("git", ["ls-files", "-v", "-z"], workspace).split("\0").filter(Boolean);
  for (const entry of entries) {
    const flag = entry[0];
    if (flag !== "S" && flag === flag.toUpperCase()) {
      continue;
    }
    const path = entry.slice(2);
    const indexed = command("git", ["ls-files", "--stage", "--", path], workspace);
    // Windows' tracked junction guard intentionally hides node_modules symlink
    // placeholders. Permit only those exact unchanged index blobs, never other
    // skip-worktree/assume-unchanged files that status and worktree remove miss.
    const guardedLink =
      flag === "S" && indexed.startsWith("120000 ") && path.split("/").includes("node_modules");
    if (!guardedLink) {
      throw new Error(
        `Index flags hide tracked work: ${path}; clear its assume-unchanged/skip-worktree flag and inspect the file`,
      );
    }
    const full = join(workspace, path);
    safePath(dirname(full));
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    const expected = command("git", ["show", `:${path}`], workspace);
    const actual =
      stat.isSymbolicLink() && process.platform !== "win32"
        ? readlinkSync(full)
        : stat.isFile()
          ? readFileSync(full, "utf8")
          : undefined;
    if (actual !== expected) {
      throw new Error(
        `Tracked dependency link changed or became a junction: ${path}; refusing removal`,
      );
    }
  }
}

function assertCleanWorkspace(task) {
  const { workspace } = paths(task);
  safePath(workspace);
  if (
    primaryRoot(workspace) !== root ||
    realpathSync(command("git", ["rev-parse", "--show-toplevel"], workspace)) !== workspace ||
    command("git", ["branch", "--show-current"], workspace) !== task.branch
  ) {
    throw new Error("Task worktree identity changed; refusing removal");
  }
  const dirty = command("git", ["status", "--porcelain", "--untracked-files=normal"], workspace);
  assertVisibleIndex(workspace);
  const ignored = command(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    workspace,
  );
  if (dirty || ignored) {
    throw new Error(
      `Worktree contains changes, untracked files, or ignored files: ${workspace}. Preserve/commit them and retry finish; no force deletion is supported.`,
    );
  }
}

async function cleanupTask(task, apply) {
  const { workspace, repository } = paths(task);
  safePath(workspace);
  if (task.docker_engine) {
    if (command("docker", ["info", "--format", "{{.ID}}"]) !== task.docker_engine) {
      throw new Error("Task Docker engine changed; switch to the original engine before cleanup");
    }
    const ids = command("docker", ["image", "ls", repository, "--no-trunc", "--quiet"])
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of new Set(ids)) {
      if (command("docker", ["ps", "-aq", "--filter", `ancestor=${id}`])) {
        throw new Error(
          `Container still references task image ${id}; stop only your task's containers before finishing`,
        );
      }
    }
    for (const id of new Set(ids)) {
      const image = JSON.parse(command("docker", ["image", "inspect", id]))[0];
      if (image.Config.Labels?.["io.platformclaw.dev.task"] !== task.token) {
        throw new Error(`Image ownership changed for ${id}; refusing cleanup`);
      }
      const tags = image.RepoTags ?? [];
      const owned = tags.filter((tag) => tag.startsWith(`${repository}:`));
      // Unique build tags avoid orphaning previous results. Never delete an
      // untagged image merely because a descendant inherited its labels.
      for (const tag of owned) {
        console.log(`${apply ? "APPLY" : "PREVIEW"}: remove task image ${tag}`);
        if (apply) {
          const current = JSON.parse(command("docker", ["image", "inspect", tag]))[0];
          if (
            current.Id !== id ||
            current.Config.Labels?.["io.platformclaw.dev.task"] !== task.token ||
            command("docker", ["ps", "-aq", "--filter", `ancestor=${id}`])
          ) {
            throw new Error(
              `Image ownership or container usage changed for ${tag}; refusing removal`,
            );
          }
          command("docker", ["image", "rm", "--no-prune", tag]);
        }
      }
    }
  }
  scratchCleanup(task, apply);
  if (existsSync(workspace)) {
    assertCleanWorkspace(task);
    console.log(
      `${apply ? "APPLY" : "PREVIEW"}: remove clean worktree ${workspace} (branch retained)`,
    );
    if (apply) {
      await locked("git-mutations", () => {
        // Another managed task can create/remove a sibling while this task runs.
        // Serialize shared Git metadata changes, not the validation commands.
        assertCleanWorkspace(task);
        command("git", ["worktree", "remove", workspace], root);
      });
    }
  }
  if (apply) {
    update(task, { state: "cleaned", note: "Disposable resources removed; Git branch retained" });
  }
}

async function createTask(name, args) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(name ?? "")) {
    throw new Error("Invalid task name");
  }
  let branch;
  let ref = "origin/main";
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === "--branch") {
      branch = args[index + 1];
    } else if (args[index] === "--ref") {
      ref = args[index + 1];
    } else {
      throw new Error(`Unknown create argument: ${args[index]}`);
    }
  }
  if (
    !/^(?:fix|feature|refactor)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch ?? "") ||
    !ref ||
    ref.startsWith("-")
  ) {
    throw new Error(
      "create requires --branch fix/name, feature/name, or refactor/name and a valid --ref",
    );
  }
  command("git", ["check-ref-format", "--branch", branch], root);
  const sha = command("git", ["rev-parse", "--verify", `${ref}^{commit}`], root);
  openRegistry();
  const task = {
    name,
    token: randomBytes(16).toString("hex"),
    branch,
    start_sha: sha,
    state: "incomplete",
    note: "Workspace creation did not complete",
    created_at: new Date().toISOString(),
    docker_engine: null,
  };
  // Record identity before creation: even an interrupted checkout has a visible owner.
  database
    .prepare(
      "INSERT INTO dev_tasks (name, token, branch, start_sha, state, note, created_at, docker_engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      task.name,
      task.token,
      task.branch,
      task.start_sha,
      task.state,
      task.note,
      task.created_at,
      task.docker_engine,
    );
  const { workspace, scratch } = paths(task);
  safePath(workspace);
  safePath(scratch);
  mkdirSync(dirname(workspace), { recursive: true });
  await locked("git-mutations", () => {
    command("git", ["worktree", "add", "-b", branch, workspace, sha], root);
    command("git", ["sparse-checkout", "disable"], workspace);
  });
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  update(task, { state: "active", note: "Workspace ready; no dependencies installed" });
  console.log(workspace);
}

async function runTask(task, args) {
  assertUsable(task);
  if (args[0] !== "--" || args.length < 2) {
    throw new Error(
      "run requires -- <executable> [arguments...]; use a shell explicitly for shell commands",
    );
  }
  const { workspace } = paths(task);
  const env = taskEnvironment(task);
  update(task, {
    state: "running",
    note: "Command may still have descendants; explicit recovery required if interrupted",
  });
  let interrupted = false;
  const child = spawn(args[1], args.slice(2), {
    cwd: workspace,
    stdio: "inherit",
    env,
  });
  const interrupt = (signal) => {
    interrupted = true;
    child.kill(signal);
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const outcome = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept({ code, signal }));
    });
    if (interrupted || outcome.signal || outcome.code === null) {
      throw new Error("Command interrupted; resources preserved until recover --confirm-stopped");
    }
    scratchCleanup(task, true);
    update(task, {
      state: "active",
      note: `Last command exited ${outcome.code}; source retained until finish`,
    });
    return outcome.code;
  } catch (error) {
    update(task, {
      state: "incomplete",
      note: "Command interrupted or cleanup failed; inspect resources before recovery",
    });
    throw error;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

function buildImage(task, args) {
  assertUsable(task);
  const [role, separator, ...buildArgs] = args;
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(role ?? "") || separator !== "--" || !buildArgs.length) {
    throw new Error("image requires <role> -- <docker build arguments/context>");
  }
  if (
    buildArgs.some(
      (arg) =>
        /^(?:-t.*|-o.*|--(?:tag|output|push|load|iidfile|metadata-file)(?:=|$))/u.test(arg) ||
        (arg.startsWith("-") && !arg.startsWith("--") && arg !== "-" && arg.length !== 2),
    )
  ) {
    throw new Error(
      "Managed image builds own their tags and local output; do not pass tag/output/push options or grouped/attached short flags (use -f Dockerfile, not -fDockerfile)",
    );
  }
  const engine = command("docker", ["info", "--format", "{{.ID}}"]);
  if (task.docker_engine && task.docker_engine !== engine) {
    throw new Error("Task belongs to a different Docker engine");
  }
  const tag = `${paths(task).repository}:${role}-${randomBytes(6).toString("hex")}`;
  const env = taskEnvironment(task);
  update(task, {
    docker_engine: engine,
    state: "running",
    note: "Image build may still be active; recover only after confirming it stopped",
  });
  // Append ownership labels after caller options; namespace tags never alias a release image.
  const result = spawnSync(
    "docker",
    ["build", ...buildArgs, "--label", `io.platformclaw.dev.task=${task.token}`, "--tag", tag],
    { cwd: paths(task).workspace, stdio: "inherit", env },
  );
  if (result.error || result.signal || result.status === null) {
    update(task, {
      state: "incomplete",
      note: "Image build interrupted; inspect Docker before recovery",
    });
    throw new Error("Image build interrupted; resources preserved");
  }
  if (result.status === 0) {
    try {
      const image = JSON.parse(command("docker", ["image", "inspect", tag]))[0];
      if (
        command("docker", ["info", "--format", "{{.ID}}"]) !== engine ||
        image.Config.Labels?.["io.platformclaw.dev.task"] !== task.token
      ) {
        throw new Error("Task image ownership/engine did not match the build");
      }
    } catch (error) {
      update(task, {
        state: "incomplete",
        note: "Docker returned success without a verified local task image; inspect the builder before recovery",
      });
      throw new Error("No verified task image was produced; resources preserved", { cause: error });
    }
  }
  try {
    scratchCleanup(task, true);
  } catch (error) {
    update(task, {
      state: "incomplete",
      note: "Image build joined but scratch cleanup failed; inspect before recovery",
    });
    throw error;
  }
  update(task, {
    state: "active",
    note: `Image build exited ${result.status}; finish removes owned image tags`,
  });
  console.log(
    result.status === 0
      ? `Task image: ${tag}`
      : `Image build failed (exit ${result.status}); finish the task to clean disposable resources`,
  );
  return result.status;
}

function audit() {
  console.log("Registered worktrees (unmanaged entries are report-only):");
  console.log(command("git", ["worktree", "list"], root));
  const origin = command("git", ["remote", "get-url", "origin"], root);
  console.log("Independent sibling clones of this repository (report-only):");
  for (const entry of readdirSync(dirname(root), { withFileTypes: true })) {
    const candidate = join(dirname(root), entry.name);
    if (!entry.isDirectory() || candidate === root || !existsSync(join(candidate, ".git"))) {
      continue;
    }
    try {
      if (
        primaryRoot(candidate) !== candidate ||
        command("git", ["remote", "get-url", "origin"], candidate) !== origin
      ) {
        continue;
      }
      const modules = lstatSync(join(candidate, "node_modules"), { throwIfNoEntry: false });
      const kind = !modules
        ? "no node_modules"
        : modules.isSymbolicLink()
          ? "node_modules link (not duplicate bytes)"
          : "physical node_modules (size not inferred)";
      console.log(`${candidate}: ${kind}`);
    } catch {
      console.log(`KEEP: could not classify ${candidate}`);
    }
  }
}

async function main() {
  const [action, name, ...args] = process.argv.slice(2);
  if (!action || action === "--help") {
    console.log(`Usage: node scripts/platformclaw-dev-task.mjs <command>
  create <name> --branch fix/name [--ref origin/main]
  run <name> -- <executable> [arguments...]
  image <name> <role> -- <docker build arguments/context>
  finish <name> [--apply]       Preview by default; retain dirty worktrees
  recover <name> --confirm-stopped
  list                         Show task ownership and unresolved outcomes
  sweep [--apply]              Retry explicitly finished tasks only
  audit                        Report legacy worktrees/clones; never delete them
Commands must be bounded and joined: do not launch detached background services.
Task images/temporary sources must use these entry points, not ad-hoc global paths.`);
    return 0;
  }
  root = primaryRoot(process.cwd());
  databasePath = join(root, ".git", "platformclaw-dev-resources.sqlite");
  if (action === "audit") {
    audit();
    return 0;
  }
  if (action === "list" || action === "sweep") {
    if (!existsSync(databasePath)) {
      console.log("No managed development tasks; legacy resources are not adopted automatically");
      return 0;
    }
    let failed = false;
    for (const task of tasks()) {
      console.log(`${task.name}\t${task.state}\t${paths(task).workspace}\t${task.note}`);
      if (action === "sweep" && task.state === "finished") {
        try {
          await locked(`task:${task.name}`, async () => {
            const current = taskByName(task.name);
            if (current.state === "finished") {
              try {
                await cleanupTask(current, name === "--apply");
              } catch (error) {
                if (name === "--apply") {
                  update(current, { note: error.message });
                }
                throw error;
              }
            }
          });
        } catch (error) {
          console.error(`KEEP: ${task.name}: ${error.message}`);
          failed = true;
        }
      }
    }
    return failed ? 1 : 0;
  }
  return await locked(`task:${name}`, async () => {
    if (action === "create") {
      await createTask(name, args);
      return 0;
    }
    const task = taskByName(name);
    if (action === "run") {
      return await runTask(task, args);
    }
    if (action === "image") {
      return buildImage(task, args);
    }
    if (action === "recover" && args.length === 1 && args[0] === "--confirm-stopped") {
      if (!["running", "incomplete"].includes(task.state)) {
        throw new Error("Only interrupted tasks require recovery");
      }
      update(task, {
        state: "active",
        note: "Operator confirmed the original command and descendants stopped",
      });
      console.log(`Recovered ${name}; inspect workspace, then run or finish explicitly`);
      return 0;
    }
    if (action !== "finish" || args.some((arg) => arg !== "--apply")) {
      throw new Error("Unknown command/arguments; use --help");
    }
    if (["running", "incomplete"].includes(task.state)) {
      throw new Error(
        "Task outcome is uncertain; inspect original command/descendants, then recover --confirm-stopped",
      );
    }
    if (task.state === "cleaned") {
      console.log(`Already cleaned: ${name}`);
      return 0;
    }
    const apply = args.includes("--apply");
    if (apply) {
      update(task, { state: "finished", note: "Completion approved; cleanup pending" });
    }
    try {
      await cleanupTask(task, apply);
    } catch (error) {
      if (apply) {
        update(task, { note: error.message });
      }
      throw error;
    }
    return 0;
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[platformclaw-dev-task] ${error.message}`);
  process.exitCode = 1;
} finally {
  database?.close();
  if (process.exitCode) {
    console.error(`[platformclaw-dev-task] FAILED (exit ${process.exitCode})`);
  }
}
