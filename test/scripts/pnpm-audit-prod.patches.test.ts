import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runDependencyVulnerabilityGate } from "../../scripts/dependency-vulnerability-gate.mjs";
import {
  filterVerifiedPatchedAdvisories,
  runPnpmAuditProd,
} from "../../scripts/pre-commit/pnpm-audit-prod.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const advisory = {
  id: "GHSA-mrhx-c7xc-m3w5",
  title: "Zod collection validation resource exhaustion",
  severity: "high",
  url: "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
  vulnerable_versions: "<4.6.6",
};
const msalAdvisory = {
  id: "GHSA-xcx6-jx8p-x3h5",
  title: "MSAL authorization code response origin validation",
  severity: "high",
  url: "https://github.com/advisories/GHSA-xcx6-jx8p-x3h5",
  vulnerable_versions: ">=5.0.0-beta.0 <7.1.0",
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "openclaw-audit-patches-"));
  roots.push(rootDir);
  const workspace = parse(await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")) as {
    patchedDependencies: Record<string, string>;
  };
  const lock = parse(await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8")) as {
    patchedDependencies: Record<string, string>;
    packages: Record<string, { resolution: { integrity: string } }>;
  };
  const artifacts = await Promise.all(
    ["zod@3.25.76", "@discord/embedded-app-sdk@2.5.0", "zod@4.6.6", "@azure/msal-node@5.4.2"].map(
      async (key) => {
        const patchPath = workspace.patchedDependencies[key]!;
        const patch = await readFile(path.join(repoRoot, patchPath));
        await mkdir(path.dirname(path.join(rootDir, patchPath)), { recursive: true });
        await writeFile(path.join(rootDir, patchPath), patch);
        return {
          key,
          patchPath,
          hash: lock.patchedDependencies[key]!,
          integrity: lock.packages[key]!.resolution.integrity,
        };
      },
    ),
  );
  const [zod, sdk, zod4, msal] = artifacts;
  const workspaceText = `patchedDependencies:\n${artifacts.map((entry) => `  '${entry.key}': ${entry.patchPath}`).join("\n")}\n`;
  const lockfileText = `lockfileVersion: '9.0'
patchedDependencies:
${artifacts.map((entry) => `  '${entry.key}': ${entry.hash}`).join("\n")}
importers:
  .:
    dependencies:
      zod:
        version: 3.25.76(patch_hash=${zod!.hash})
      '@discord/embedded-app-sdk':
        version: 2.5.0(patch_hash=${sdk!.hash})
      current-zod:
        version: npm:zod@4.6.6(patch_hash=${zod4!.hash})
      '@azure/msal-node':
        version: 5.4.2(patch_hash=${msal!.hash})
packages:
${artifacts.map((entry) => `  '${entry.key}':\n    resolution: {integrity: '${entry.integrity}'}`).join("\n")}
snapshots:
  zod@3.25.76(patch_hash=${zod!.hash}): {}
  '@discord/embedded-app-sdk@2.5.0(patch_hash=${sdk!.hash})':
    dependencies:
      zod: 3.25.76(patch_hash=${zod!.hash})
  zod@4.6.6(patch_hash=${zod4!.hash}): {}
  '@azure/msal-node@5.4.2(patch_hash=${msal!.hash})': {}
`;
  await writeFile(path.join(rootDir, "pnpm-workspace.yaml"), workspaceText);
  await writeFile(path.join(rootDir, "pnpm-lock.yaml"), lockfileText);
  return { rootDir, lockfileText, workspaceText, artifacts };
}

describe("reviewed audit patch identities", () => {
  it.each(["production", "full graph"])(
    "checks original versions and recognizes the actual reviewed artifacts in the %s audit",
    async (gate) => {
      const { rootDir } = await fixture();
      const payloads: unknown[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected the advisory payload");
        }
        payloads.push(JSON.parse(init.body));
        return Response.json({ zod: [advisory], "@azure/msal-node": [msalAdvisory] });
      };
      if (gate === "production") {
        expect(await runPnpmAuditProd({ rootDir, fetchImpl, stdout: { write: () => true } })).toBe(
          0,
        );
      } else {
        expect((await runDependencyVulnerabilityGate({ rootDir, fetchImpl })).blockers).toEqual([]);
      }
      expect(payloads).not.toEqual([]);
      expect(
        payloads.every((payload) => JSON.stringify(payload).includes('"zod":["3.25.76","4.6.6"]')),
      ).toBe(true);
      expect(
        payloads.every((payload) =>
          JSON.stringify(payload).includes('"@azure/msal-node":["5.4.2"]'),
        ),
      ).toBe(true);
    },
  );

  it.each([
    "missing Zod patch",
    "changed Zod patch",
    "changed SDK patch",
    "changed current Zod patch",
    "workspace registration",
    "lock registration",
    "install hash",
    "upstream integrity",
    "unpatched snapshot",
    "unpatched SDK snapshot",
    "missing SDK registration",
    "missing current Zod registration",
    "base version",
  ])("fails closed for %s", async (change) => {
    const { rootDir, lockfileText, workspaceText, artifacts } = await fixture();
    const [zod, sdk, zod4] = artifacts;
    let changedLock = lockfileText;
    if (change === "missing Zod patch") {
      await rm(path.join(rootDir, zod!.patchPath));
    } else if (
      change === "changed Zod patch" ||
      change === "changed SDK patch" ||
      change === "changed current Zod patch"
    ) {
      const artifact =
        change === "changed Zod patch" ? zod! : change === "changed SDK patch" ? sdk! : zod4!;
      await writeFile(path.join(rootDir, artifact.patchPath), "unreviewed patch bytes\n");
    } else if (change === "workspace registration") {
      await writeFile(
        path.join(rootDir, "pnpm-workspace.yaml"),
        workspaceText.replace(zod!.patchPath, "patches/unused.patch"),
      );
    } else if (change === "lock registration") {
      changedLock = lockfileText.replace(`  '${zod!.key}': ${zod!.hash}\n`, "");
    } else if (change === "install hash") {
      changedLock = lockfileText.replaceAll(zod!.hash, "0".repeat(zod!.hash.length));
    } else if (change === "upstream integrity") {
      changedLock = lockfileText.replace(zod!.integrity, "sha512-unreviewed");
    } else if (change === "unpatched snapshot") {
      changedLock = lockfileText.replaceAll(`(patch_hash=${zod!.hash})`, "");
    } else if (change === "unpatched SDK snapshot") {
      changedLock = lockfileText.replaceAll(`(patch_hash=${sdk!.hash})`, "");
    } else if (
      change === "missing SDK registration" ||
      change === "missing current Zod registration"
    ) {
      const artifact = change === "missing SDK registration" ? sdk! : zod4!;
      await writeFile(
        path.join(rootDir, "pnpm-workspace.yaml"),
        workspaceText.replace(`  '${artifact.key}': ${artifact.patchPath}\n`, ""),
      );
    } else {
      changedLock = lockfileText.replaceAll("3.25.76", "3.25.75");
    }
    await expect(
      filterVerifiedPatchedAdvisories({
        rootDir,
        lockfileText: changedLock,
        advisoriesByPackage: { zod: [advisory] },
      }),
    ).rejects.toThrow();
  });

  it("verifies active SDK artifacts even when the registry returns no advisory", async () => {
    const { rootDir, lockfileText, artifacts } = await fixture();
    await writeFile(path.join(rootDir, artifacts[1]!.patchPath), "unreviewed SDK parser\n");
    await expect(
      filterVerifiedPatchedAdvisories({ rootDir, lockfileText, advisoriesByPackage: {} }),
    ).rejects.toThrow("Reviewed audit patch bytes changed: @discord/embedded-app-sdk@2.5.0");
  });

  it("keeps another advisory and changes to the reviewed advisory range or severity blocking", async () => {
    const { rootDir, lockfileText } = await fixture();
    const other = {
      ...advisory,
      id: "GHSA-unrelated",
      url: "https://github.com/advisories/GHSA-unrelated",
    };
    const changedRange = { ...advisory, vulnerable_versions: "<4.7.0" };
    const critical = { ...advisory, severity: "critical" };
    expect(
      await filterVerifiedPatchedAdvisories({
        rootDir,
        lockfileText,
        advisoriesByPackage: { zod: [advisory, other, changedRange, critical] },
      }),
    ).toEqual({ zod: [other, changedRange, critical] });
  });

  it("keeps a newly resolved vulnerable Zod version blocking alongside the reviewed backport", async () => {
    const { rootDir, lockfileText } = await fixture();
    const changedLock = `${lockfileText}  zod@4.6.5: {}\n`;
    await expect(
      filterVerifiedPatchedAdvisories({
        rootDir,
        lockfileText: changedLock,
        advisoriesByPackage: { zod: [advisory] },
      }),
    ).rejects.toThrow("No reviewed security patch for zod@4.6.5");
  });

  it.each([
    "missing patch",
    "changed bytes",
    "workspace registration",
    "missing workspace registration",
    "lock registration",
    "install hash",
    "upstream integrity",
    "unpatched snapshot",
    "base version",
  ])("rejects MSAL %s through both audit entrypoints", async (change) => {
    const { rootDir, lockfileText, workspaceText, artifacts } = await fixture();
    const msal = artifacts[3]!;
    let changedLock = lockfileText;
    if (change === "missing patch") {
      await rm(path.join(rootDir, msal.patchPath));
    } else if (change === "changed bytes") {
      await writeFile(path.join(rootDir, msal.patchPath), "unreviewed MSAL bytes\n");
    } else if (change === "workspace registration" || change === "missing workspace registration") {
      const changedWorkspace =
        change === "workspace registration"
          ? workspaceText.replace(msal.patchPath, "patches/unused.patch")
          : workspaceText.replace(`  '${msal.key}': ${msal.patchPath}\n`, "");
      await writeFile(path.join(rootDir, "pnpm-workspace.yaml"), changedWorkspace);
    } else if (change === "lock registration") {
      changedLock = lockfileText.replace(`  '${msal.key}': ${msal.hash}\n`, "");
    } else if (change === "install hash") {
      changedLock = lockfileText.replaceAll(msal.hash, "0".repeat(msal.hash.length));
    } else if (change === "upstream integrity") {
      changedLock = lockfileText.replace(msal.integrity, "sha512-unreviewed");
    } else if (change === "unpatched snapshot") {
      changedLock = lockfileText.replaceAll(`(patch_hash=${msal.hash})`, "");
    } else {
      changedLock = lockfileText.replaceAll("5.4.2", "5.4.1");
    }
    await writeFile(path.join(rootDir, "pnpm-lock.yaml"), changedLock);
    // Empty registry results must not make a tampered installed backport pass.
    const fetchImpl: typeof fetch = async () => Response.json({});
    await expect(runPnpmAuditProd({ rootDir, fetchImpl })).rejects.toThrow();
    await expect(runDependencyVulnerabilityGate({ rootDir, fetchImpl })).rejects.toThrow();
  });

  it("preserves other MSAL advisories and changes to the reviewed range or severity", async () => {
    const { rootDir, lockfileText } = await fixture();
    const other = { ...msalAdvisory, url: "https://github.com/advisories/GHSA-unrelated" };
    const changedRange = { ...msalAdvisory, vulnerable_versions: "<7.2.0" };
    const critical = { ...msalAdvisory, severity: "critical" };
    expect(
      await filterVerifiedPatchedAdvisories({
        rootDir,
        lockfileText,
        advisoriesByPackage: { "@azure/msal-node": [msalAdvisory, other, changedRange, critical] },
      }),
    ).toEqual({ "@azure/msal-node": [other, changedRange, critical] });
  });

  it("rejects a second unpatched MSAL snapshot alongside the reviewed backport", async () => {
    const { rootDir, lockfileText } = await fixture();
    await expect(
      filterVerifiedPatchedAdvisories({
        rootDir,
        lockfileText: `${lockfileText}  '@azure/msal-node@5.4.2': {}\n`,
        advisoriesByPackage: { "@azure/msal-node": [msalAdvisory] },
      }),
    ).rejects.toThrow(
      "Reviewed audit patch registration or integrity changed: @azure/msal-node@5.4.2",
    );
  });
});
