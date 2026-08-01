import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { reconcileManagedConfig } from "../../docker/platformclaw-runtime/reconcile-managed-config.mjs";
import { validateManagedConfig } from "../../docker/platformclaw-runtime/validate-managed-config.mjs";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mjs";

type ComposeService = {
  build?: { context?: string; dockerfile?: string };
  cap_add?: string[];
  cap_drop?: string[];
  command?: string[];
  depends_on?: Record<string, { condition?: string }>;
  entrypoint?: string[];
  environment?: Record<string, string>;
  networks?: Record<string, { aliases?: string[] }>;
  network_mode?: string;
  ports?: string[];
  pull_policy?: string;
  profiles?: string[];
  read_only?: boolean;
  secrets?: string[];
  security_opt?: string[];
  tmpfs?: string[];
  user?: string;
  volumes?: string[];
  privileged?: boolean;
};

type ComposeConfig = {
  services: Record<string, ComposeService>;
};

type WorkflowConfig = {
  jobs: Record<string, { "runs-on"?: string }>;
};

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("PlatformClaw Docker runtime", () => {
  it("exports immutable runtime and sandbox image tags in the transfer archive", () => {
    const build = readRepoFile("scripts/platformclaw-build.mjs");

    expect(build).toContain(
      'run("docker", ["save", "-o", artifactTemp, runtimeShaTag, sandboxShaTag])',
    );
    expect(build).not.toContain(
      'run("docker", ["save", "-o", artifactPath, runtimeVersionTag, sandboxVersionTag])',
    );
  });

  it("boots the runtime under a host UID that is absent from the image", () => {
    const dockerfile = readRepoFile("Dockerfile.jammy");
    const entrypoint = readRepoFile("docker/platformclaw-runtime/platformclaw-runtime-entrypoint");
    const build = readRepoFile("scripts/platformclaw-build.mjs");

    expect(dockerfile).toContain("libnss-wrapper");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/platformclaw-runtime-entrypoint"]');
    expect(entrypoint).toContain('getent passwd "$runtime_uid"');
    expect(entrypoint).toContain('getent group "$runtime_gid"');
    expect(entrypoint).toContain('exec /usr/bin/tini -s -- "$@"');
    expect(build).toContain('"1003:1003"');
    expect(build).toContain('"ssh -G -F /dev/null platformclaw.invalid >/dev/null"');
  });

  it("bounds home-development Docker and release artifact storage", () => {
    const build = readRepoFile("scripts/platformclaw-build.mjs");
    const cleanup = readRepoFile("scripts/platformclaw-dev-cleanup.mjs");
    const maintenance = readRepoFile("scripts/platformclaw-dev-maintenance.ps1");
    const compact = readRepoFile("scripts/platformclaw-docker-vhdx-compact.ps1");

    expect(build).toContain("cleanupAfterBuild(buildSucceeded, Boolean(publicationDirectoryLock))");
    expect(build).toContain('"--skip-final-images"');
    expect(build).not.toContain('cleanupArgs.push("--skip-final-images", "--skip-archives")');
    expect(build).not.toContain('cleanupArgs.push("--failed-build-sha"');
    expect(build).toContain('"--output-dir"');
    expect(build).toContain('"--skip-cache"');
    expect(build).toContain("publishOwnedLock(publicationLockPath, {");
    expect(build).toContain("await acquireDockerResourceLock()");
    expect(build).toContain('server.listen({ host: "127.0.0.1", port, exclusive: true }');
    expect(build).not.toContain("Reusing verified");
    expect(build).toContain("previousRuntimeShaId = optionalImageId(runtimeShaTag)");
    expect(build).toContain("restoreImageTag(tag, imageId)");
    expect(build).toContain("removeDanglingImage(failedImageId, previousId)");
    expect(build).toContain("if (existsSync(publicationLockPath))");
    expect(build).toContain("await acquireOutputDirectoryLock(options.outputDir)");
    expect(build).toContain("49_152 + (key % 8_192)");
    expect(build).toContain("candidateRuntimeId: optionalImageId(runtimeShaTag)");
    expect(build).not.toContain("linkSync(");
    expect(build).toContain("publicationCommitted = true");
    expect(build).toContain("removeOwnedLock(publicationLockPath, publicationLockOwner)");
    expect(build).toContain("publicationArtifactBackup");
    expect(build).toContain("rollbackPublicationFiles()");
    expect(build).toContain('"--build-lock-owner"');
    expect(build).toContain("restoreImageTag(tag, imageId)");
    expect(build).toContain("renameSync(artifactPath, publicationArtifactBackup)");
    expect(build).toContain("renameSync(publicationArtifactBackup, publicationArtifactPath)");
    expect(build).toContain("/No such image/u.test(result.stderr)");
    for (const repository of [
      "platformclaw-jammy-build",
      "platformclaw-openclaw-build",
      "platformclaw-runtime-assets",
      "platformclaw-control-assets",
    ]) {
      expect(cleanup).toContain(`"${repository}"`);
    }
    expect(cleanup).toContain("keepRollbackImages: 1");
    expect(cleanup).toContain("!options.intermediateSha || row.Tag === options.intermediateSha");
    expect(cleanup).toContain("keepReleaseArchives: 3");
    expect(cleanup).toContain('cacheMax: "20gb"');
    expect(cleanup).toContain('"--all"');
    expect(cleanup).toMatch(/if \(options\.skipCache\) \{\s+return;/u);
    expect(cleanup).toContain("remove unvalidated final image");
    expect(cleanup).toContain("remove incomplete release artifact");
    expect(cleanup).toContain("remove abandoned release temporary");
    expect(cleanup).toContain("acquireCleanupLock(options)");
    expect(cleanup).toContain("dockerResourceLockPort()");
    expect(cleanup).toContain("a PlatformClaw build is active");
    expect(cleanup).toContain("/No such object/u.test(result.stderr)");
    expect(cleanup).toMatch(/if \(error\?\.code === "ENOENT"\) \{\s+return;/u);
    expect(cleanup).toContain("release publication is active");
    expect(cleanup).not.toContain("processIsAlive(owner.pid)");
    expect(cleanup).toContain("finish committed release publication");
    expect(cleanup).toContain("roll back abandoned release publication");
    expect(cleanup).toContain("renameSync(artifactBackup, archive)");
    expect(cleanup).toContain("restoreImageTag(owner.runtimeVersionTag, owner.previousRuntimeId)");
    expect(cleanup).toContain(
      "optionalImageId(owner.runtimeVersionTag) === owner.candidateRuntimeId",
    );
    expect(cleanup).toContain("const validatedIds");
    expect(cleanup).toContain("remove orphan release backup");
    expect(cleanup).toContain("await acquireOutputDirectoryLock(options)");
    expect(cleanup.indexOf("if (options.skipArchives)")).toBeLessThan(
      cleanup.indexOf("roll back abandoned release publication"),
    );
    expect(cleanup).not.toContain('docker(["image", "rm", "--force"');
    expect(maintenance).toContain("New-ScheduledTaskTrigger -Weekly");
    expect(compact).toContain("Optimize-VHD -Path $resolved -Mode Full");
    expect(compact).toContain("$expectedPrefix");
    expect(compact).toContain("Assert-NoReparsePoint $resolved");
    expect(compact).toContain("PlatformClawPathDeleteGuard");
    expect(compact).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(compact).toContain("wsl.exe --shutdown");
  });

  it("publishes only the BFF while sharing the private Gateway namespace", () => {
    const compose = parse(
      readRepoFile("docker/platformclaw-runtime/compose.yaml"),
    ) as ComposeConfig;
    const gateway = compose.services["openclaw-gateway"];
    const control = compose.services["platformclaw-control"];
    const stateInit = compose.services["platformclaw-state-init"];

    expect(gateway?.ports).toBeUndefined();
    expect(gateway?.user).toContain("PLATFORMCLAW_RUNTIME_UID");
    expect(control?.ports).toEqual(["0.0.0.0:${PLATFORMCLAW_PUBLIC_PORT:-19001}:19001"]);
    expect(control?.user).toContain("PLATFORMCLAW_RUNTIME_UID");
    expect(stateInit?.user).toBe("0:0");
    expect(stateInit?.network_mode).toBe("none");
    expect(stateInit?.cap_add).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER"]);
    expect(stateInit?.volumes).toContain(
      "${PLATFORMCLAW_DEPLOY_HOST_ROOT:?run platformclaw-compose with a service user}/data/gateway-home/.openclaw:/state/gateway",
    );
    expect(gateway?.depends_on).toMatchObject({
      "platformclaw-state-init": { condition: "service_completed_successfully" },
    });
    expect(control?.network_mode).toBeUndefined();
    expect(gateway?.networks?.["platformclaw-gateway-backplane"]?.aliases).toEqual([
      "gateway.platformclaw.local",
    ]);
    expect(gateway?.networks).toHaveProperty("platformclaw-gateway-egress");
    expect(control?.networks).toHaveProperty("platformclaw-gateway-backplane");
    expect(control?.networks?.["platformclaw-gateway-backplane"]?.aliases).toEqual([
      "control.platformclaw.local",
    ]);
    expect(gateway?.environment?.PLATFORMCLAW_KNOX_CONTROL_PLANE_URL).toBe(
      "http://control.platformclaw.local:19001/platformclaw/internal/knox/route",
    );
    expect(control?.environment?.PLATFORMCLAW_GATEWAY_URL).toBe(
      "ws://gateway.platformclaw.local:18789",
    );
    expect(control?.secrets).toEqual([
      "platformclaw_gateway_token",
      "platformclaw_gateway_service_identity",
      "platformclaw_execution_service_token",
      "platformclaw_initial_admin_ids",
      "platformclaw_knox_service_token",
      "platformclaw_ssh_credential_master_key",
    ]);
    expect(gateway?.secrets).toEqual([
      "platformclaw_gateway_token",
      "platformclaw_execution_service_token",
      "platformclaw_knox_webhook_secret",
      "platformclaw_knox_service_token",
    ]);
    expect(gateway?.environment?.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE).toBe(
      "/run/secrets/platformclaw_execution_service_token",
    );
    expect(gateway?.environment?.DOCKER_HOST).toBe(
      "unix:///run/platformclaw-sandbox-docker/docker.sock",
    );
    expect(gateway?.volumes).toContain(
      "platformclaw-credential-broker:/run/platformclaw-credential-broker:ro",
    );
    expect(gateway?.volumes).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(gateway?.volumes).toContain(
      "${PLATFORMCLAW_DEPLOY_HOST_ROOT:?run platformclaw-compose with a service user}/data/workspaces:${PLATFORMCLAW_DEPLOY_ROOT:?run platformclaw-compose with a service user}/data/workspaces",
    );
    expect(gateway?.environment?.OPENCLAW_STATE_DIR).toBe(
      "${PLATFORMCLAW_DEPLOY_ROOT:?run platformclaw-compose with a service user}/data/gateway-home/.openclaw",
    );
    expect(gateway?.tmpfs).toEqual([
      "${PLATFORMCLAW_DEPLOY_ROOT:?run platformclaw-compose with a service user}/data/gateway-home:uid=${PLATFORMCLAW_RUNTIME_UID:?run platformclaw-compose with a service user},gid=${PLATFORMCLAW_RUNTIME_GID:?run platformclaw-compose with a service user},mode=0700",
    ]);
  });

  it("seeds the required private admin RPC without storing a token", () => {
    const config = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(config);

    expect(config).toMatchObject({
      gateway: { mode: "local", bind: "lan", auth: { mode: "token" } },
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "platformclaw-execution",
            scope: "agent",
            workspaceAccess: "rw",
            docker: {
              image: "__PLATFORMCLAW_SANDBOX_IMAGE__",
              network: "bridge",
              user: "0:0",
            },
          },
        },
      },
      tools: { sandbox: { tools: { alsoAllow: ["bundle-mcp"] } } },
      plugins: {
        entries: {
          "admin-http-rpc": { enabled: true },
          "platformclaw-execution": { enabled: true },
        },
      },
    });
    expect(serialized).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(serialized).not.toContain("platformclaw_gateway_token");
  });

  it("reconciles deployment-owned sandbox image and global MCP access", () => {
    const source = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as {
      agents: {
        defaults: {
          model?: { primary: string };
          sandbox: { docker: { image: string } };
        };
        entries?: Record<string, unknown>;
      };
      tools: { sandbox: { tools: { alsoAllow: string[] } } };
    };
    source.agents.defaults.sandbox.docker.image = "platformclaw-sandbox:old";
    source.agents.defaults.model = { primary: "openai/gpt-5.4" };
    source.agents.entries = { person_one: { name: "Person One" } };

    source.tools = { sandbox: { tools: { alsoAllow: ["memory_search"] } } };

    const result = reconcileManagedConfig(source, "platformclaw-sandbox:new");

    expect(result.changed).toBe(true);
    expect(result.config.agents.defaults.sandbox.docker.image).toBe("platformclaw-sandbox:new");
    expect(result.config.agents.defaults.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(result.config.agents.entries).toEqual(source.agents.entries);
    expect(result.config.tools.sandbox.tools.alsoAllow).toEqual(["memory_search", "bundle-mcp"]);
    expect(source.agents.defaults.sandbox.docker.image).toBe("platformclaw-sandbox:old");
  });

  it("migrates an existing managed config to enable the Knox plugin", () => {
    const source = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as {
      agents: { defaults: { sandbox: { docker: { image: string } } } };
      plugins: { entries: Record<string, unknown> };
    };
    source.agents.defaults.sandbox.docker.image = "platformclaw-sandbox:test";
    delete source.plugins.entries.knox;

    const result = reconcileManagedConfig(source, "platformclaw-sandbox:test");

    expect(result.changed).toBe(true);
    expect(result.config.plugins.entries.knox).toEqual({ enabled: true });
    expect(() => validateManagedConfig(result.config, "platformclaw-sandbox:test")).not.toThrow();
  });

  it("adds global MCP access to an existing explicit sandbox allowlist", () => {
    const source = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as {
      agents: { defaults: { sandbox: { docker: { image: string } } } };
      tools: { sandbox: { tools: { allow?: string[]; alsoAllow?: string[] } } };
    };
    source.agents.defaults.sandbox.docker.image = "platformclaw-sandbox:test";
    source.tools.sandbox.tools = { allow: ["read"] };

    const result = reconcileManagedConfig(source, "platformclaw-sandbox:test");

    expect(result.changed).toBe(true);
    expect(result.config.tools.sandbox.tools).toEqual({ allow: ["read", "bundle-mcp"] });
    expect(reconcileManagedConfig(result.config, "platformclaw-sandbox:test").changed).toBe(false);
  });

  it("preserves an unrestricted empty sandbox allowlist", () => {
    const source = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as {
      agents: { defaults: { sandbox: { docker: { image: string } } } };
      tools: { sandbox: { tools: { allow?: string[]; alsoAllow?: string[] } } };
    };
    source.agents.defaults.sandbox.docker.image = "platformclaw-sandbox:test";
    source.tools.sandbox.tools = { allow: [] };

    const result = reconcileManagedConfig(source, "platformclaw-sandbox:test");

    expect(result.changed).toBe(false);
    expect(result.config.tools.sandbox.tools).toEqual({ allow: [] });
    expect(() => validateManagedConfig(result.config, "platformclaw-sandbox:test")).not.toThrow();
  });

  it("adds global MCP access to config created before the managed gate existed", () => {
    const source = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as {
      agents: { defaults: { sandbox: { docker: { image: string } } } };
      tools?: unknown;
    };
    source.agents.defaults.sandbox.docker.image = "platformclaw-sandbox:test";
    delete source.tools;

    const result = reconcileManagedConfig(source, "platformclaw-sandbox:test");

    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      tools: { sandbox: { tools: { alsoAllow: ["bundle-mcp"] } } },
    });
  });

  it("reconciles an agent sandbox alsoAllow override that replaces the global gate", () => {
    const source = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as {
      agents: {
        defaults: { sandbox: { docker: { image: string } } };
        entries?: Record<string, unknown>;
      };
    };
    source.agents.defaults.sandbox.docker.image = "platformclaw-sandbox:test";
    source.agents.entries = {
      person_one: { tools: { sandbox: { tools: { alsoAllow: [] } } } },
    };

    const result = reconcileManagedConfig(source, "platformclaw-sandbox:test");

    expect(result.changed).toBe(true);
    expect(result.config.agents.entries).toMatchObject({
      person_one: {
        tools: { sandbox: { tools: { alsoAllow: ["bundle-mcp"] } } },
      },
    });
    expect(() => validateManagedConfig(result.config, "platformclaw-sandbox:test")).not.toThrow();
  });

  it("fails closed when persistent config would bypass managed execution", () => {
    const entrypoint = readRepoFile("docker/platformclaw-runtime/platformclaw-gateway");
    const config = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as Record<string, unknown>;
    const sandboxImage = "platformclaw-sandbox:test";
    const defaults = (config.agents as { defaults: { sandbox: { docker: { image: string } } } })
      .defaults.sandbox;
    defaults.docker.image = sandboxImage;

    expect(() => validateManagedConfig(config, sandboxImage)).not.toThrow();
    expect(entrypoint).toContain("/etc/platformclaw/validate-managed-config.mjs");
    const validator = readRepoFile("docker/platformclaw-runtime/validate-managed-config.mjs");
    expect(validator).toContain('import("/app/dist/config/config.js")');
    expect(validator).toContain("loadConfig({ pin: false })");
    expect(validator).not.toContain("JSON.parse");
    expect(entrypoint).toContain("sandbox Docker endpoint must be rootless");
    expect(entrypoint).toContain('docker image inspect -- "$sandbox_image"');
    expect(entrypoint.indexOf("docker image inspect --")).toBeLessThan(
      entrypoint.indexOf('if [[ ! -e "$config_path" ]]'),
    );
    expect(entrypoint).toContain('config_tmp="$(mktemp');
    expect(entrypoint).toContain('mv -- "$config_tmp" "$config_path"');
    expect(entrypoint).toContain('"$sandbox_image" == -*');

    const missingGlobalMcpGate = structuredClone(config) as {
      tools: { sandbox: { tools: { alsoAllow: string[] } } };
    };
    missingGlobalMcpGate.tools.sandbox.tools.alsoAllow = [];
    expect(() => validateManagedConfig(missingGlobalMcpGate, sandboxImage)).toThrow(
      "Existing OpenClaw config does not match the managed PlatformClaw execution policy",
    );

    for (const deniedGate of ["bundle-mcp", "bundle-*", "*mcp", "group:plugins", "*"]) {
      const candidate = structuredClone(config) as {
        tools: { sandbox: { tools: { deny?: string[] } } };
      };
      candidate.tools.sandbox.tools.deny = [deniedGate];
      expect(() => validateManagedConfig(candidate, sandboxImage)).toThrow(
        "Existing OpenClaw config does not match the managed PlatformClaw execution policy",
      );
      expect(() => reconcileManagedConfig(candidate, sandboxImage)).toThrow(
        "Existing sandbox tool deny policy blocks managed global MCP",
      );
    }

    const agentOverride = structuredClone(config) as {
      agents: { entries?: Record<string, unknown> };
    };
    agentOverride.agents.entries = {
      person_one: { tools: { sandbox: { tools: { alsoAllow: [] } } } },
    };
    expect(() => validateManagedConfig(agentOverride, sandboxImage)).toThrow(
      "Existing OpenClaw config does not match the managed PlatformClaw execution policy",
    );

    const unsafeOverrides = [
      { mode: "off" },
      { backend: "ssh" },
      { docker: { network: "host" } },
      { docker: { binds: ["/:/host"] } },
      { docker: { dangerouslyAllowExternalBindSources: true } },
      { docker: { readOnlyRoot: false } },
      { docker: { capDrop: [] } },
      { browser: { allowHostControl: true } },
      { browser: { binds: ["/host:/browser-host"] } },
    ];
    for (const sandbox of unsafeOverrides) {
      const candidate = structuredClone(config) as {
        agents: { entries?: Record<string, { sandbox: unknown }> };
      };
      candidate.agents.entries = { legacy: { sandbox } };
      expect(() => validateManagedConfig(candidate, sandboxImage)).toThrow(
        "Existing OpenClaw config does not match the managed PlatformClaw execution policy",
      );
    }

    const unsafeConfigMutators = [
      (candidate: Record<string, unknown>) => {
        candidate.tools = { elevated: { enabled: true } };
      },
      (candidate: Record<string, unknown>) => {
        candidate.tools = { exec: { host: "gateway" } };
      },
      (candidate: Record<string, unknown>) => {
        candidate.tools = { exec: { host: "node" } };
      },
      (candidate: Record<string, unknown>) => {
        (candidate.agents as Record<string, unknown>).list = [
          { id: "legacy", sandbox: { mode: "off" } },
        ];
      },
      (candidate: Record<string, unknown>) => {
        (candidate.agents as Record<string, unknown>).entries = {
          legacy: { tools: { elevated: { enabled: true } } },
        };
      },
      (candidate: Record<string, unknown>) => {
        (candidate.agents as Record<string, unknown>).entries = {
          legacy: { tools: { exec: { host: "gateway" } } },
        };
      },
    ];
    for (const mutate of unsafeConfigMutators) {
      const candidate = structuredClone(config) as Record<string, unknown>;
      mutate(candidate);
      expect(() => validateManagedConfig(candidate, sandboxImage)).toThrow(
        "Existing OpenClaw config does not match the managed PlatformClaw execution policy",
      );
    }
  });

  it("copies the upstream Control UI output into the runtime asset path", () => {
    const assetsDockerfile = readRepoFile("docker/platformclaw-runtime/Dockerfile.assets");

    expect(assetsDockerfile).toContain("COPY --from=build /app/dist/control-ui /app/ui/dist");
  });

  it("bundles private workspace runtime dependencies into the control artifact", () => {
    const buildConfig = readRepoFile("packages/platformclaw-control-plane/tsdown.config.ts");

    expect(buildConfig).toContain("alwaysBundle: [/^@openclaw\\//u]");
    expect(buildConfig).toContain("dts: { neverBundle: [/^@openclaw\\//u] }");
  });

  it("keeps ephemeral secret mounts readable only through the private smoke directory", () => {
    const smoke = readRepoFile("scripts/e2e/platformclaw-runtime-docker.sh");
    const workflow = readRepoFile(".github/workflows/platformclaw-ci.yml");

    expect(smoke).toContain('work_dir="$(mktemp -d)"');
    expect(smoke).toContain('docker image inspect "$PLATFORMCLAW_IMAGE"');
    expect(smoke).toContain("docker run --rm --network none --read-only --user 0:0");
    expect(smoke).toContain("--cap-drop ALL --cap-add DAC_OVERRIDE");
    expect(smoke).toContain("/cleanup -mindepth 1 -depth -delete");
    expect(smoke).toContain("chmod 0777");
    expect(smoke).toContain('chmod 0444 "$PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR"');
    expect(smoke).toContain('chmod 0444 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"');
    expect(smoke).toContain(
      'openssl genpkey -algorithm ED25519 -out "$PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE"',
    );
    expect(smoke).toContain('"$PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE"');
    expect(smoke).toContain("SSH credential master key leaked into container logs");
    expect(smoke).toContain("Execution service token leaked into container logs");
    expect(smoke).not.toContain('chmod 0600 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"');
    expect(workflow).toContain(
      "PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE: /tmp/platformclaw-empty-secret",
    );
  });

  it("provides a persistent, manually resettable Windows VM preview", () => {
    const preview = readRepoFile("scripts/platformclaw-vm-preview.ps1");
    const previewCompose = parse(
      readRepoFile("docker/platformclaw-runtime/compose.preview.yaml"),
    ) as ComposeConfig;

    expect(preview).toContain('[ValidateSet("Menu", "Start", "Stop", "Status", "Logs", "Reset")]');
    expect(preview).toContain('"platformclaw-vm-preview"');
    expect(preview).toContain("safeconnect.platformclaw.test");
    expect(preview).toContain("platformclaw-safeconnect-fixture-password");
    expect(preview).toContain('Invoke-Compose @("down", "--volumes", "--remove-orphans")');
    expect(preview).toContain("Refusing to reset an unmarked or broad path");
    expect(preview).toContain("existing non-empty, unmarked data root");
    expect(preview).toContain("$manifest.runtimeImageId -eq $runtimeImageId");
    expect(preview).toContain("$archivedImageId -ne $sandboxImageId");
    expect(preview).toContain("Get-RunningControlImageId");
    expect(preview).toContain("EmployeeAuthCa = Join-Path");
    expect(preview).toContain("Initialize-PreviewCa $Paths");
    expect(preview).toContain("PLATFORMCLAW_EMPLOYEE_AUTH_CA_FILE");
    expect(preview).toContain("PLATFORMCLAW_KNOX_CDEP_URL");
    expect(preview).toContain("PLATFORMCLAW_KNOX_WEBHOOK_SECRET_SECRET_FILE");
    expect(preview).toContain("PLATFORMCLAW_KNOX_SERVICE_TOKEN_SECRET_FILE");
    expect(preview).toContain("PLATFORMCLAW_DEPLOY_HOST_ROOT = $Paths.Root");
    expect(preview).toContain("Repair-PreviewEmployeeAuth");
    expect(preview).toContain("Test-RunningGatewayApiKey");
    expect(preview).toContain("The preview model credential changed; recreating Gateway");
    expect(preview).toContain(
      'Invoke-Compose @("up", "--detach", "--force-recreate", "employee-auth-mock")',
    );
    expect(preview).toContain("$paths.GatewayServiceIdentity,");
    expect(preview).toContain("The source image changed; recreating the preview containers");
    expect(preview).toContain("compose.preview.yaml");
    expect(preview).toContain('[string]$Model = "openai/gpt-5.4"');
    expect(preview).toContain("OPENAI_API_KEY is not set");
    expect(preview).toContain("[switch]$AllowDirty");
    expect(preview).toContain("$needsBuild = $Rebuild -or $DirtyCheckout -or");
    expect(preview).toContain("if (-not $DirtyCheckout)");
    expect(preview).toContain("$sha256.ComputeHash");
    expect(preview).toContain(
      "Testing uncommitted local changes; no transfer artifact will be created",
    );
    expect(previewCompose.services["openclaw-gateway"]?.environment?.OPENAI_API_KEY).toBe(
      "${OPENAI_API_KEY:-}",
    );
    expect(previewCompose.services["sandbox-docker-init"]?.command?.join("\n")).toContain(
      ".platformclaw-initialized",
    );
    expect(preview).toContain('"$($Paths.SandboxTar).tmp-$PID"');
    expect(preview).not.toContain("Remove-Item -LiteralPath $resolved -Recurse");
    expect(preview).not.toContain("PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY=");
  });

  it("keeps the HTTP employee auth mock on the control loopback", () => {
    const smokeCompose = parse(
      readRepoFile("docker/platformclaw-runtime/compose.smoke.yaml"),
    ) as ComposeConfig;
    const mock = smokeCompose.services["employee-auth-mock"];
    const control = smokeCompose.services["platformclaw-control"];

    expect(mock?.network_mode).toBe("service:platformclaw-control");
    expect(mock?.command).toContain("127.0.0.1");
    expect(control?.environment?.PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL).toBe(
      "http://127.0.0.1:18080/login",
    );
    expect(control?.depends_on).toBeUndefined();
  });

  it("models the confirmed SafeConnect SSH boundary without publishing it", () => {
    const smoke = parse(
      readRepoFile("docker/platformclaw-runtime/compose.smoke.yaml"),
    ) as ComposeConfig;
    const fake = smoke.services["fake-safeconnect"];
    const gateway = smoke.services["openclaw-gateway"];
    const server = readRepoFile("scripts/e2e/lib/platformclaw-fake-safeconnect/server.py");
    const fixtureDockerfile = readRepoFile(
      "scripts/e2e/lib/platformclaw-fake-safeconnect/Dockerfile",
    );
    const fixtureRequirements = readRepoFile(
      "scripts/e2e/lib/platformclaw-fake-safeconnect/requirements.txt",
    );

    expect(fake?.build).toEqual({
      context: "${PLATFORMCLAW_REPO_ROOT:?set PLATFORMCLAW_REPO_ROOT}",
      dockerfile: "scripts/e2e/lib/platformclaw-fake-safeconnect/Dockerfile",
    });
    expect(fake?.ports).toBeUndefined();
    expect(fake?.read_only).toBe(true);
    expect(fake?.cap_drop).toEqual(["ALL"]);
    expect(fake?.cap_add).toEqual(["SETGID", "SETUID"]);
    expect(fake?.security_opt).toEqual(["no-new-privileges:true"]);
    expect(fake?.volumes).toEqual([
      "platformclaw-smoke-safeconnect-state:/state",
      "platformclaw-smoke-safeconnect-users:/users",
      "platformclaw-smoke-safeconnect-appdata:/appdata",
    ]);
    expect(fake?.networks).toEqual({
      "platformclaw-gateway-egress": { aliases: ["safeconnect.platformclaw.test"] },
    });
    expect(gateway?.depends_on).toMatchObject({
      "fake-safeconnect": { condition: "service_healthy" },
    });
    expect(server).toContain('return "SSH Direct Connect", "", "en-US", [("Password:", False)]');
    expect(server).toContain("def kbdint_auth_supported(self) -> bool:");
    expect(server).toContain("password_auth=False");
    expect(server).toContain("public_key_auth=False");
    expect(server).not.toContain('responses[0], "password"');
    expect(fixtureDockerfile).toContain("--requirement /fixture/requirements.txt");
    expect(fixtureRequirements).toContain("asyncssh==2.24.0");
    expect(fixtureRequirements).not.toMatch(/^\s*[^#\s][^=\n]*$/mu);
  });

  it("uses an isolated rootless Docker daemon only in the smoke harness", () => {
    const production = parse(
      readRepoFile("docker/platformclaw-runtime/compose.yaml"),
    ) as ComposeConfig;
    const smoke = parse(
      readRepoFile("docker/platformclaw-runtime/compose.smoke.yaml"),
    ) as ComposeConfig;

    expect(production.services).not.toHaveProperty("sandbox-docker");
    const init = smoke.services["sandbox-docker-init"];
    expect(init?.user).toBe("0:0");
    expect(init?.network_mode).toBe("none");
    expect(init?.cap_add).toEqual(["CHOWN"]);
    expect(init?.volumes).toContain("platformclaw-smoke-docker-run:/run/user/1000");
    expect(smoke.services["sandbox-docker"]?.privileged).toBe(true);
    expect(smoke.services["sandbox-docker"]?.depends_on).toMatchObject({
      "sandbox-docker-init": { condition: "service_completed_successfully" },
    });
    expect(smoke.services["sandbox-image-loader"]?.entrypoint).toEqual(["bash", "-ceu"]);
    expect(smoke.services["openclaw-gateway"]?.depends_on).toMatchObject({
      "sandbox-image-loader": { condition: "service_completed_successfully" },
    });
    expect(smoke.services["sandbox-docker"]?.volumes).toContain(
      "platformclaw-smoke-docker-run:/run/user/1000",
    );
    expect(smoke.services["openclaw-gateway"]?.volumes).toContain(
      "platformclaw-smoke-docker-run:/run/platformclaw-sandbox-docker:ro",
    );
  });

  it("runs the rootless Docker smoke on the Jammy kernel policy", () => {
    const workflow = parse(
      readRepoFile(".github/workflows/platformclaw-docker-smoke.yml"),
    ) as WorkflowConfig;

    expect(workflow.jobs.smoke?.["runs-on"]).toBe("ubuntu-22.04");
  });

  it("provides an explicit one-shot migration for the legacy workspace volume", () => {
    const compose = parse(
      readRepoFile("docker/platformclaw-runtime/compose.yaml"),
    ) as ComposeConfig;
    const migration = compose.services["platformclaw-workspace-migration"];

    expect(migration?.profiles).toEqual(["migration"]);
    expect(migration?.network_mode).toBe("none");
    expect(migration?.volumes).toEqual([
      "platformclaw-workspaces:/source:ro",
      "${PLATFORMCLAW_DEPLOY_HOST_ROOT:?run platformclaw-compose with a service user}/data/workspaces:/target",
    ]);
    expect(migration?.entrypoint).toEqual(["platformclaw-migrate-workspaces"]);
    const migrationScript = readRepoFile("docker/platformclaw-runtime/migrate-workspaces");
    const runtimeDockerfile = readRepoFile("Dockerfile.jammy");
    expect(migrationScript).toContain("refusing to overwrite");
    expect(migrationScript).toContain('cp -a "$source_dir"/. "$target_dir"/');
    expect(migrationScript).toContain('chown -R "$runtime_uid:$runtime_gid" "$target_dir"');
    expect(runtimeDockerfile).toContain(
      "docker/platformclaw-runtime/migrate-workspaces /usr/local/bin/platformclaw-migrate-workspaces",
    );
  });

  it("detects the production service account instead of assuming uid 1000", () => {
    const readme = readRepoFile("docker/platformclaw-runtime/README.md");
    const wrapper = readRepoFile("docker/platformclaw-runtime/platformclaw-compose");
    const initState = readRepoFile("docker/platformclaw-runtime/init-state");

    expect(wrapper).toContain('runtime_uid="$(id -u "$service_user")"');
    expect(wrapper).toContain('runtime_gid="$(id -g "$service_user")"');
    expect(wrapper).toContain('service_home="$(getent passwd "$service_user" | cut -d: -f6)"');
    expect(wrapper).toContain("$service_home/platformclaw");
    expect(wrapper).toContain('PLATFORMCLAW_DEPLOY_HOST_ROOT="$PLATFORMCLAW_DEPLOY_ROOT"');
    expect(wrapper).toContain("unix:///var/run/docker.sock");
    expect(wrapper).toContain("unset DOCKER_CONTEXT");
    expect(wrapper).toContain("PLATFORMCLAW_COMPOSE_PROJECT:-platformclaw");
    expect(wrapper).toContain("/run/user/$runtime_uid");
    expect(wrapper).toContain("platformclaw-credential-broker-$runtime_uid-$runtime_gid");
    expect(wrapper).toContain('if [[ "$1" == "environment" ]]');
    expect(initState).toContain('find "$state_dir" -xdev');
    expect(initState).toContain('-exec chown -h "$runtime_uid:$runtime_gid" {} +');
    expect(initState).not.toContain("/state/workspaces");
    const ownerMigration = readRepoFile("docker/platformclaw-runtime/migrate-workspace-owner");
    expect(ownerMigration).toContain("PLATFORMCLAW_PREVIOUS_RUNTIME_UID");
    expect(ownerMigration).toContain('find "$workspace_dir" -xdev -uid "$previous_uid"');
    expect(ownerMigration).toContain('chown -h "$runtime_uid"');
    expect(readme).toContain("--profile owner-migration");
    const compose = parse(
      readRepoFile("docker/platformclaw-runtime/compose.yaml"),
    ) as ComposeConfig;
    expect(compose.services["platformclaw-workspace-owner-migration"]?.cap_add).toEqual([
      "CHOWN",
      "DAC_READ_SEARCH",
    ]);
    expect(readme).toContain("platformclaw-compose --service-user platformclaw");
    expect(readme).toContain("Secret values do\nnot belong in that environment file");
    const deploy = readRepoFile("docker/platformclaw-runtime/platformclaw-deploy");
    expect(deploy).toContain("Legacy migration requires one administrator run");
    expect(deploy).toContain("--employee-auth-login-url");
    expect(deploy).toContain("validate_deployment_env");
    expect(deploy).toContain('image inspect "$sandbox_image"');
    expect(deploy).toContain("PLATFORMCLAW_INITIAL_ADMIN_IDS_SOURCE");
    expect(deploy).toContain("Initial admin IDs source has no account ID");
    expect(deploy).toContain('generate_secret "$secret_root/gateway-token"');
    expect(deploy).toContain("existing secret does not match legacy");
    expect(deploy).toContain("--cap-add CHOWN");
    expect(deploy).toContain('cmp -s "$legacy_secret" "$target_secret"');
    expect(deploy).toContain("config edit");
    expect(deploy).toContain("restart_gateway_and_wait");
    expect(deploy).toContain("require_immutable_image_ref");
    expect(deploy).toContain('"${compose[@]}" restart openclaw-gateway platformclaw-control');
    expect(deploy).toContain('cp -p "$backup" "$config_path"');
    expect(deploy).toContain("image rollback");
    expect(deploy).toContain("image cleanup [--apply]");
    expect(deploy).toContain("set_image_pair");
    expect(deploy).toContain('runuser -u "$service_user"');
    expect(deploy).toContain('"${legacy_project}_platformclaw-gateway-state"');
    expect(deploy).toContain('"${legacy_project}_platformclaw-workspaces"');
    expect(deploy).toContain("Migrated durable state requires its original secrets");
    expect(deploy).toContain("Refusing to skip durable volume");
    expect(deploy).toContain("Skip empty legacy volume");
    expect(deploy).toContain('legacy_state_marker="$deploy_root/.legacy-durable-state"');
    expect(deploy).toContain('[[ -f "$legacy_state_marker" ]]');
    expect(deploy).toContain("quiesce_rootless_sandboxes");
    expect(deploy).toContain('find "$gateway_state" "$control_state" -mindepth 1');
    expect(deploy).toContain("restore_previous_images");
    expect(deploy).toContain("image_pair_available");
    expect(deploy).toContain("no deployment state was changed");
    expect(deploy).toContain("No registry pull was attempted");
    expect(deploy).toContain("create_gateway_state_backup");
    expect(deploy).toContain("restore_gateway_state_backup");
    expect(deploy).toContain("doctor --fix --yes --non-interactive");
    expect(deploy).toContain("restoring previous image refs and Gateway state");
    expect(deploy).toContain("Rollback failed. Current deployment env restored");
    expect(deploy).toContain("PlatformClaw already uses");
    expect(deploy).toContain('image inspect "$previous_sandbox"');
    expect(deploy).toContain("recreate_sandboxes");
    expect(deploy).toContain("node /app/openclaw.mjs sandbox recreate --all --force");
    expect(deploy.indexOf('"${compose[@]}" up -d --wait &&')).toBeLessThan(
      deploy.indexOf('[[ "$current_sandbox" == "$sandbox_image" ]] || recreate_sandboxes'),
    );
    expect(deploy.indexOf("recreate_sandboxes; }; then")).toBeLessThan(
      deploy.indexOf('echo "PlatformClaw updated: $main_image / $sandbox_image"'),
    );
    expect(deploy).toContain('scan_cleanup_repository "main" "platformclaw"');
    expect(deploy).toContain('scan_cleanup_repository "sandbox" "platformclaw-sandbox"');
    expect(deploy).toContain('if [[ "$image_id" == "$current_id" ]]');
    expect(deploy).toContain('elif [[ -n "${used_ids[$image_id]:-}" ]]');
    expect(deploy).toContain('if [[ "$apply" != "1" ]]');
    expect(deploy).toContain("Cleanup removes rollback images");
    expect(deploy).not.toContain("docker image prune");
    expect(deploy).not.toContain("docker image rm --force");
    expect(deploy).toContain("employee-auth-ca.crt");
    expect(compose.services["platformclaw-state-init"]?.pull_policy).toBe("never");
    expect(compose.services["openclaw-gateway"]?.pull_policy).toBe("never");
    expect(compose.services["platformclaw-control"]?.pull_policy).toBe("never");
    const releasePrepare = readRepoFile(
      ".agents/skills/release-platformclaw/scripts/prepare-release.mjs",
    );
    expect(releasePrepare).toContain(
      "uploadPaths: [...localAssets.map((entry) => entry.path), manifestPath]",
    );
    expect(releasePrepare).toContain("manifestFile: basename(manifestPath)");
    expect(releasePrepare).toContain('"release-upload-plan.local.json"');
    expect(releasePrepare).toContain("--date must be a real calendar date");
  });

  it("registers a deterministic Docker scheduler lane", () => {
    const smokeLane = mainLanes.find((lane) => lane.name === "platformclaw-runtime");
    expect(smokeLane).toMatchObject({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=0 pnpm test:docker:platformclaw-runtime",
      resources: ["docker", "service"],
    });
    expect(smokeLane?.e2eImageKind).toBeUndefined();
  });
});
