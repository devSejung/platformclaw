import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mjs";

type ComposeService = {
  command?: string[];
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
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

    expect(gateway?.ports).toEqual(["127.0.0.1:${PLATFORMCLAW_PUBLIC_PORT:-19001}:19001"]);
    expect(gateway?.user).toBe("1000:1000");
    expect(control?.ports).toBeUndefined();
    expect(control?.user).toBe("1000:1000");
    expect(control?.network_mode).toBe("service:openclaw-gateway");
    expect(control?.environment?.PLATFORMCLAW_GATEWAY_URL).toBe("ws://127.0.0.1:18789");
    expect(control?.secrets).toEqual([
      "platformclaw_gateway_token",
      "platformclaw_initial_admin_ids",
    ]);
  });

  it("seeds the required private admin RPC without storing a token", () => {
    const config = JSON.parse(
      readRepoFile("docker/platformclaw-runtime/openclaw.initial.json"),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(config);

    expect(config).toMatchObject({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token" } },
      plugins: { entries: { "admin-http-rpc": { enabled: true } } },
    });
    expect(serialized).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(serialized).not.toContain("platformclaw_gateway_token");
  });

  it("keeps ephemeral secret mounts readable only through the private smoke directory", () => {
    const smoke = readRepoFile("scripts/e2e/platformclaw-runtime-docker.sh");

    expect(smoke).toContain('work_dir="$(mktemp -d)"');
    expect(smoke).toContain('chmod 0444 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"');
    expect(smoke).not.toContain('chmod 0600 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"');
  });

  it("documents the production file-secret ownership contract", () => {
    const readme = readRepoFile("docker/platformclaw-runtime/README.md");

    expect(readme).toContain("UID/GID `1000:1000`");
    expect(readme).toContain("-o 1000 -g 1000 -m 0400 gateway-token");
    expect(readme).toContain("Do not store\neither value in Compose YAML or an environment file.");
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
