import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
} from "./store.js";

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

describe("workspace-owned external auth overlays", () => {
  afterEach(() => {
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it.each([
    { label: "default discovery", externalCli: undefined },
    { label: "disabled CLI discovery", externalCli: { mode: "none" } },
    { label: "existing CLI discovery", externalCli: { mode: "existing" } },
    { label: "scoped CLI discovery", externalCli: { mode: "scoped", providerIds: [] } },
  ] satisfies Array<{ label: string; externalCli: ExternalCliAuthDiscovery | undefined }>)(
    "keeps $label scoped while re-reading current external credentials",
    async ({ externalCli }) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-external-workspace-")),
      );
      const agentDir = path.join(root, "agent");
      const workspaceA = path.join(root, "project-a");
      const workspaceB = path.join(root, "project-b");
      const profileId = "workspace-provider:stored";
      const config: OpenClawConfig = { plugins: { enabled: false } };
      let generation = 1;
      let available = true;
      externalAuthTesting.setResolveExternalAuthProfilesForTest((params) => {
        expect(params.config).toBe(config);
        expect(params.context.config).toBe(config);
        expect(params.workspaceDir).toBe(params.context.workspaceDir);
        expect(params.context.agentDir).toBe(agentDir);
        if (!available) {
          return [];
        }
        return [
          {
            profileId,
            credential: {
              type: "oauth",
              provider: "workspace-provider",
              access: `${params.context.workspaceDir}:${generation}`,
              refresh: "external-refresh",
              expires: Date.now() + 60_000,
            },
          },
        ];
      });
      try {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "workspace-provider",
                access: "persisted-fallback",
                refresh: "persisted-refresh",
                expires: Date.now() + 60_000,
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        const read = (workspaceDir: string) =>
          ensureAuthProfileStore(agentDir, {
            config,
            workspaceDir,
            inheritedAuthDir: agentDir,
            externalCli,
            readOnly: true,
            syncExternalCli: false,
          }).profiles[profileId];

        expect(read(workspaceA)).toMatchObject({ access: `${workspaceA}:1` });
        expect(read(workspaceB)).toMatchObject({ access: `${workspaceB}:1` });
        generation += 1;
        expect(read(workspaceA)).toMatchObject({ access: `${workspaceA}:2` });
        expect(
          loadAuthProfileStoreForSecretsRuntime(agentDir, {
            config,
            workspaceDir: workspaceB,
            inheritedAuthDir: agentDir,
            externalCli,
          }).profiles[profileId],
        ).toMatchObject({ access: `${workspaceB}:2` });
        available = false;
        expect(read(workspaceA)).toMatchObject({ access: "persisted-fallback" });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
