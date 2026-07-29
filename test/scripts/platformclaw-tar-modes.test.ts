import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { patchTarModes } from "../../scripts/platformclaw-tar-modes.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PlatformClaw release tar modes", () => {
  it("records executable deployment entrypoints on every build host", () => {
    const root = mkdtempSync(join(tmpdir(), "platformclaw-tar-modes-"));
    temporaryDirectories.push(root);
    for (const name of ["compose.yaml", "platformclaw-compose", "platformclaw-deploy"]) {
      writeFileSync(join(root, name), `${name}\n`, "utf8");
    }

    const rawArchive = join(root, "bundle.tar");
    const create = spawnSync(
      "tar",
      [
        "-cf",
        rawArchive,
        "--format=ustar",
        "-C",
        root,
        "compose.yaml",
        "platformclaw-compose",
        "platformclaw-deploy",
      ],
      { encoding: "utf8" },
    );
    expect(create.status, create.stderr).toBe(0);

    const archive = join(root, "bundle.tar.gz");
    const patched = patchTarModes(
      readFileSync(rawArchive),
      new Map([
        ["compose.yaml", 0o644],
        ["platformclaw-compose", 0o755],
        ["platformclaw-deploy", 0o755],
      ]),
    );
    writeFileSync(archive, gzipSync(patched));

    const list = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" });
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/^-rw-r--r--.*compose\.yaml$/mu);
    expect(list.stdout).toMatch(/^-rwxr-xr-x.*platformclaw-compose$/mu);
    expect(list.stdout).toMatch(/^-rwxr-xr-x.*platformclaw-deploy$/mu);
  });

  it("fails when a required entry is absent", () => {
    const emptyArchive = Buffer.alloc(1024);
    expect(() => patchTarModes(emptyArchive, new Map([["platformclaw-deploy", 0o755]]))).toThrow(
      "Tar archive is missing mode targets: platformclaw-deploy",
    );
  });
});
