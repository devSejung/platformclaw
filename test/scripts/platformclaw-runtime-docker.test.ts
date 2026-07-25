import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
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
  it("publishes only the BFF while sharing the private Gateway namespace", () => {
    const compose = parse(
      readRepoFile("docker/platformclaw-runtime/compose.yaml"),
    ) as ComposeConfig;
    const gateway = compose.services["openclaw-gateway"];
    const control = compose.services["platformclaw-control"];

    expect(gateway?.ports).toBeUndefined();
    expect(gateway?.user).toBe("1000:1000");
    expect(control?.ports).toEqual(["127.0.0.1:${PLATFORMCLAW_PUBLIC_PORT:-19001}:19001"]);
    expect(control?.user).toBe("1000:1000");
    expect(control?.network_mode).toBeUndefined();
    expect(gateway?.networks?.["platformclaw-gateway-backplane"]?.aliases).toEqual([
      "gateway.platformclaw.local",
    ]);
    expect(control?.networks).toHaveProperty("platformclaw-gateway-backplane");
    expect(control?.environment?.PLATFORMCLAW_GATEWAY_URL).toBe(
      "ws://gateway.platformclaw.local:18789",
    );
    expect(control?.secrets).toEqual([
      "platformclaw_gateway_token",
      "platformclaw_execution_service_token",
      "platformclaw_initial_admin_ids",
      "platformclaw_ssh_credential_master_key",
    ]);
    expect(gateway?.secrets).toEqual([
      "platformclaw_gateway_token",
      "platformclaw_execution_service_token",
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
      "/var/lib/platformclaw/workspaces:/var/lib/platformclaw/workspaces",
    );
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

    expect(smoke).toContain('work_dir="$(mktemp -d)"');
    expect(smoke).toContain('docker image inspect "$PLATFORMCLAW_IMAGE"');
    expect(smoke).toContain("docker run --rm --network none --read-only --user 0:0");
    expect(smoke).toContain("--cap-drop ALL --cap-add DAC_OVERRIDE");
    expect(smoke).toContain("/cleanup -mindepth 1 -depth -delete");
    expect(smoke).toContain("chmod 0777");
    expect(smoke).toContain('chmod 0444 "$PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR"');
    expect(smoke).toContain('chmod 0444 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"');
    expect(smoke).toContain("SSH credential master key leaked into container logs");
    expect(smoke).toContain("Execution service token leaked into container logs");
    expect(smoke).not.toContain('chmod 0600 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"');
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
      "/var/lib/platformclaw/workspaces:/target",
    ]);
    expect(migration?.entrypoint).toEqual(["platformclaw-migrate-workspaces"]);
    const migrationScript = readRepoFile("docker/platformclaw-runtime/migrate-workspaces");
    const runtimeDockerfile = readRepoFile("Dockerfile.jammy");
    expect(migrationScript).toContain("refusing to overwrite");
    expect(migrationScript).toContain('cp -a "$source_dir"/. "$target_dir"/');
    expect(runtimeDockerfile).toContain(
      "docker/platformclaw-runtime/migrate-workspaces /usr/local/bin/platformclaw-migrate-workspaces",
    );
  });

  it("documents the production file-secret ownership contract", () => {
    const readme = readRepoFile("docker/platformclaw-runtime/README.md");

    expect(readme).toContain("UID/GID `1000:1000`");
    expect(readme).toContain("-o 1000 -g 1000 -m 0400 gateway-token");
    expect(readme).toContain("Do not store\ntheir values in Compose YAML or an environment file.");
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
