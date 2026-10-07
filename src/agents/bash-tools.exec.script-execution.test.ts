/** Exec scripts through the selected shell; interpreters own source diagnostics. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec-run.js";

// Isolate authorization from execution: exercise commands after host approval.
vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: async () => ({ allowWithoutEnforcedCommand: true }),
}));
vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by script execution tests");
  },
}));
vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const createScriptTool = () =>
  createExecTool({
    host: "gateway",
    security: "full",
    ask: "on-miss",
    allowBackground: false,
    notifyOnExit: false,
  });

describe("exec script execution", () => {
  it.each(["script.js", "nested/script.js"])("runs valid JavaScript at %s", async (fileName) => {
    await withTempDir("openclaw-exec-script-", async (workdir) => {
      const scriptPath = path.join(workdir, fileName);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        'NODE: { const $TOKEN = "$HOME"; process.stdout.write($TOKEN); }',
      );
      const result = await createScriptTool().execute("script", {
        command: `node "${scriptPath}"`,
        workdir,
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.content).toEqual([{ type: "text", text: "$HOME" }]);
    });
  });

  it("returns interpreter syntax errors as process failures", async () => {
    await withTempDir("openclaw-exec-script-", async (workdir) => {
      await fs.writeFile(path.join(workdir, "bad.js"), "const value = ;");
      const result = await createScriptTool().execute("bad-script", {
        command: "node bad.js",
        workdir,
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 1 });
      expect(JSON.stringify(result.content)).toContain("SyntaxError");
    });
  });
});

describe.skipIf(process.platform === "win32")("exec POSIX skill commands", () => {
  it.each([
    ["tilde home", "cd ~/skills/demo &&"],
    ["home variable", 'cd "$HOME/skills/demo" &&'],
    ["directory variable", 'SKILL_DIR="$HOME/skills/demo"; cd "$SKILL_DIR" &&'],
    ["command substitution", 'cd "$(printf %s "$HOME/skills/demo")" &&'],
  ])("runs Python skill arguments with %s", async (_name, prefix) => {
    await withTempDir("openclaw-exec-skill-", async (workdir) => {
      const workspaceDir = path.join(workdir, "workspace");
      const skillDir = path.join(workdir, "home", "skills", "demo");
      await fs.mkdir(workspaceDir);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "script.py"),
        [
          "import sys",
          "# Keep $TOKEN as documentation, not shell syntax.",
          'print("$HOME:" + "|".join(sys.argv[1:]))',
        ].join("\n"),
      );
      const result = await createScriptTool().execute("skill-script", {
        command: `HOME='${path.join(workdir, "home")}'; ${prefix} python3 script.py --input 'input file.pdf'`,
        workdir: workspaceDir,
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.content).toEqual([{ type: "text", text: "$HOME:--input|input file.pdf" }]);
    });
  });

  it.each([
    "node script.js --input 'input file.pdf' > output.txt && cat output.txt",
    "node script.js --input 'input file.pdf' | cat",
    "env node script.js --input 'input file.pdf'",
    "sh -c 'node script.js --input \"input file.pdf\"'",
  ])("runs a skill through %s", async (invocation) => {
    await withTempDir("openclaw-exec-skill-", async (workdir) => {
      const skillDir = path.join(workdir, "skill dir");
      await fs.mkdir(skillDir);
      await fs.writeFile(
        path.join(skillDir, "script.js"),
        'process.stdout.write("$HOME:" + process.argv.slice(2).join("|"));',
      );
      const result = await createScriptTool().execute("skill-shell", {
        command: `cd "${skillDir}" && ${invocation}`,
        workdir,
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.content).toEqual([{ type: "text", text: "$HOME:--input|input file.pdf" }]);
    });
  });

  it("returns a failed cd without running the script", async () => {
    await withTempDir("openclaw-exec-script-", async (workdir) => {
      await fs.writeFile(path.join(workdir, "script.js"), 'process.stdout.write("must-not-run");');
      const result = await createScriptTool().execute("missing-directory", {
        command: "cd missing-directory && node script.js",
        workdir,
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: expect.any(Number) });
      expect(result.details).not.toMatchObject({ exitCode: 0 });
      expect(JSON.stringify(result.content)).toContain("missing-directory");
      expect(JSON.stringify(result.content)).not.toContain("must-not-run");
    });
  });
});

describe("exec interactive OpenClaw channel login guard", () => {
  it("recognizes direct and package-runner channel login commands before execution", async () => {
    await expect(
      detectUnsafeExecControlShellCommand("openclaw channels login --channel whatsapp"),
    ).resolves.toBe("channel-login");
    expect(
      await detectUnsafeExecControlShellCommand(
        "pnpm exec openclaw channels login --channel whatsapp --verbose",
      ),
    ).toBe("channel-login");
    await expect(
      detectUnsafeExecControlShellCommand("openclaw channels status --deep"),
    ).resolves.toBeNull();
  });

  it("blocks interactive channel login commands from exec", async () => {
    const tool = createScriptTool();

    await expect(
      tool.execute("call-openclaw-channel-login", {
        command: "openclaw channels login --channel whatsapp --verbose",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-wrapped-openclaw-channel-login", {
        command: "sudo -u openclaw bash -lc 'openclaw channels login --channel whatsapp'",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-clustered-sudo-channel-login", {
        command: "sudo -EH bash -lc 'openclaw channels login --channel whatsapp'",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-deep-env-channel-login", {
        command: "env env env env env env openclaw channels login --channel whatsapp",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-env-s-trailing-channel-login", {
        command: "env -S 'openclaw channels' login --channel whatsapp",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
  });
});
