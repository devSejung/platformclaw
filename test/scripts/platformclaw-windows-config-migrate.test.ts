import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { migrateWindowsPreviewConfig } from "../../scripts/platformclaw-windows-config-migrate.mjs";

async function createConfig(value: unknown): Promise<{ configPath: string; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "platformclaw-windows-config-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { configPath, root };
}

describe("PlatformClaw Windows preview config migration", () => {
  it("migrates retired agent arrays and metadata with a recoverable backup", async () => {
    const legacy = {
      gateway: { mode: "local" },
      agents: {
        list: [
          { id: "main" },
          { id: "person_one", name: "Person One", workspace: "C:/work/person_one" },
        ],
      },
      meta: { lastTouchedVersion: "2026.7.2", lastTouchedAt: "2026-07-22T00:00:00Z" },
    };
    const { configPath, root } = await createConfig(legacy);

    const result = await migrateWindowsPreviewConfig(configPath);

    expect(result.migrated).toBe(true);
    expect(result.changes).toContain("Moved agents.list → keyed agents.entries.");
    const migrated = JSON.parse(await readFile(configPath, "utf8"));
    expect(migrated).toMatchObject({
      gateway: { mode: "local" },
      agents: {
        entries: {
          main: {},
          person_one: { name: "Person One", workspace: "C:/work/person_one" },
        },
      },
      meta: { lastTouchedVersion: "2026.7.2" },
    });
    expect(migrated.meta).not.toHaveProperty("lastTouchedAt");
    expect(JSON.parse(await readFile(`${configPath}.bak`, "utf8"))).toEqual(legacy);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves canonical configs unchanged without creating a backup", async () => {
    const canonical = { agents: { entries: { main: {} } } };
    const { configPath, root } = await createConfig(canonical);

    const result = await migrateWindowsPreviewConfig(configPath);

    expect(result).toEqual({ migrated: false, changes: [] });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(canonical);
    expect(await readdir(root)).toEqual(["openclaw.json"]);
  });

  it("parses supported JSON5 before applying migrations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platformclaw-windows-config-json5-"));
    const configPath = path.join(root, "openclaw.json");
    await writeFile(
      configPath,
      `{ // managed preview\n agents: { list: [{ id: "person_one" }], },\n}`,
      "utf8",
    );

    await expect(migrateWindowsPreviewConfig(configPath)).resolves.toMatchObject({
      migrated: true,
    });
    expect(JSON5.parse(await readFile(configPath, "utf8"))).toMatchObject({
      agents: { entries: { person_one: {} } },
    });
  });

  it("writes a single migrated section back to its owning include file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platformclaw-windows-config-include-"));
    const configPath = path.join(root, "openclaw.json");
    const agentsPath = path.join(root, "agents.json5");
    const rootRaw = `{ agents: { $include: "./agents.json5" } }`;
    const agentsRaw = `{ list: [{ id: "person_one" }] }`;
    await writeFile(configPath, rootRaw, "utf8");
    await writeFile(agentsPath, agentsRaw, "utf8");

    await expect(migrateWindowsPreviewConfig(configPath)).resolves.toMatchObject({
      migrated: true,
    });
    expect(await readFile(configPath, "utf8")).toBe(rootRaw);
    expect(JSON5.parse(await readFile(agentsPath, "utf8"))).toEqual({
      entries: { person_one: {} },
    });
    expect(await readFile(`${agentsPath}.bak`, "utf8")).toBe(agentsRaw);
  });

  it("does not modify malformed config files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "platformclaw-windows-config-invalid-"));
    const configPath = path.join(root, "openclaw.json");
    await writeFile(configPath, "{ invalid", "utf8");

    await expect(migrateWindowsPreviewConfig(configPath)).rejects.toThrow(
      "Unable to parse managed preview config",
    );
    expect(await readFile(configPath, "utf8")).toBe("{ invalid");
    expect(await readdir(root)).toEqual(["openclaw.json"]);
  });

  it("migrates before process startup and cleans child windows after a failed start", async () => {
    const script = await readFile(
      new URL("../../scripts/platformclaw-windows.ps1", import.meta.url),
      "utf8",
    );

    expect(script).toContain('"scripts\\platformclaw-windows-config-migrate.mjs"');
    expect(script.indexOf("Initialize-Runtime $sourceRoot")).toBeLessThan(
      script.indexOf('$auth = Start-VisibleShell "PlatformClaw - employee auth mock"'),
    );
    expect(script).toContain('Write-Step "Startup failed; closing processes opened by this run"');
    expect(script).toContain('"platformclaw-user-mcp": { "enabled": true }');
    expect(script).toContain('"PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE"');
    expect(script).toContain('$knoxServiceTokenFile = Join-Path $runtimeRoot "knox-service-token"');
    expect(script).toContain("$env:PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE = $knoxServiceTokenFile");
    expect(script).toContain("Stop-ProcessTree -ProcessId $startedProcesses[$index].Id");
    expect(script).toContain(
      'Wait-HttpEndpoint "http://127.0.0.1:$GatewayPort/healthz" "Gateway" -TimeoutSeconds 240',
    );
  });
});
