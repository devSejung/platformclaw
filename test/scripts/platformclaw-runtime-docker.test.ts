import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mjs";

type ComposeService = {
  command?: string[];
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
  networks?: Record<string, { aliases?: string[] }>;
  network_mode?: string;
  ports?: string[];
  secrets?: string[];
  user?: string;
  volumes?: string[];
};

type ComposeConfig = {
  services: Record<string, ComposeService>;
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
      "platformclaw_initial_admin_ids",
      "platformclaw_ssh_credential_master_key",
    ]);
    expect(gateway?.secrets).toEqual(["platformclaw_gateway_token"]);
  });

  it("seeds the required private admin RPC without storing a token", () => {
    const config = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(config);

    expect(config).toMatchObject({
      gateway: { mode: "local", bind: "lan", auth: { mode: "token" } },
      plugins: { entries: { "admin-http-rpc": { enabled: true } } },
    });
    expect(serialized).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(serialized).not.toContain("platformclaw_gateway_token");
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
    expect(smoke).toContain('chmod 0444 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"');
    expect(smoke).toContain("SSH credential master key leaked into container logs");
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
