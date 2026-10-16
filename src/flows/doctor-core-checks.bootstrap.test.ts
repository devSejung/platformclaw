// Bootstrap diagnostics cover per-agent limits and deferred multi-agent checks.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

function getBootstrapSizeCheck() {
  const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/bootstrap-size");
  if (!check) {
    throw new Error("Missing bootstrap size health check");
  }
  return check;
}

describe("core/doctor/bootstrap-size", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("honors the per-agent bootstrapMaxChars override in health findings", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-bootstrap-"));
    // This size fits the global default but exceeds the default agent's effective budget.
    await fs.writeFile(join(tmp, "AGENTS.md"), "a".repeat(15_000), "utf-8");

    const check = getBootstrapSizeCheck();
    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          defaults: {
            workspace: tmp,
            bootstrapMaxChars: 20_000,
          },
          list: [{ id: "custom-agent", default: true, bootstrapMaxChars: 10_000 }],
        },
      },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: expect.stringContaining("AGENTS.md"),
        fixHint: expect.stringContaining("agents.entries.*.bootstrapMaxChars"),
      }),
    );
  });

  it("reports secondary-agent truncation when the default agent is healthy", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-bootstrap-fleet-"));
    const primaryWorkspace = join(tmp, "primary");
    const secondaryWorkspace = join(tmp, "secondary");
    await fs.mkdir(primaryWorkspace);
    await fs.mkdir(secondaryWorkspace);
    await fs.writeFile(join(primaryWorkspace, "AGENTS.md"), "Small instructions", "utf8");
    await fs.writeFile(join(secondaryWorkspace, "AGENTS.md"), "a".repeat(15_000), "utf8");

    const check = getBootstrapSizeCheck();
    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          defaults: { bootstrapMaxChars: 20_000 },
          entries: {
            primary: { default: true, workspace: primaryWorkspace },
            secondary: { workspace: secondaryWorkspace, bootstrapMaxChars: 10_000 },
          },
        },
      },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining('Agent "secondary": AGENTS.md'),
        path: join(secondaryWorkspace, "AGENTS.md"),
      }),
    );
    expect(findings.some((finding) => finding.path === join(primaryWorkspace, "AGENTS.md"))).toBe(
      false,
    );
  });
});
