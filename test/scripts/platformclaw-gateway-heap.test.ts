import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimeRoot = path.resolve("docker/platformclaw-runtime");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const hasCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const heapKey = "PLATFORMCLAW_GATEWAY_MAX_OLD_SPACE_SIZE";

function shellPath(value: string): string {
  return process.platform === "win32"
    ? value
        .replaceAll("\\", "/")
        .replace(/^([a-z]):/iu, (_, drive: string) => `/${drive.toLowerCase()}`)
    : value;
}

function runShell(script: string, env: NodeJS.ProcessEnv) {
  const scriptFile = path.join(tempDirs.make("platformclaw-shell-"), "probe.sh");
  writeFileSync(scriptFile, script);
  return spawnSync(bash, ["-eu", shellPath(scriptFile)], {
    env: { ...process.env, NODE_OPTIONS: "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function createLauncherFixture() {
  const root = tempDirs.make("platformclaw-gateway-heap-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const launcher = path.join(root, "platformclaw-gateway");
  // Replace only the fixed secret mount with synthetic data; execute the whole launcher.
  writeFileSync(
    launcher,
    readFileSync(path.join(runtimeRoot, "platformclaw-gateway"), "utf8").replace(
      'gateway_token_path="/run/secrets/platformclaw_gateway_token"',
      'gateway_token_path="$PLATFORMCLAW_TEST_TOKEN_FILE"',
    ),
  );
  const token = path.join(root, "gateway-token");
  const config = path.join(root, "openclaw.json");
  const probe = path.join(root, "gateway-probe.cjs");
  writeFileSync(token, "synthetic-test-token");
  writeFileSync(config, "{}\n");
  writeFileSync(
    probe,
    'console.log(JSON.stringify({pid:process.pid,options:process.env.NODE_OPTIONS??"",limit:require("node:v8").getHeapStatistics().heap_size_limit,args:process.argv.slice(2)}));\n',
  );
  writeFileSync(
    path.join(bin, "docker"),
    '#!/usr/bin/env bash\nif [[ "$1" == info ]]; then printf \'["name=rootless"]\\n\'; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "node"),
    String.raw`#!/usr/bin/env bash
# Config preflight is stubbed; final gateway exec uses the real Node runtime.
if [[ "$1" != /app/openclaw.mjs ]]; then exit 0; fi
probe="$PLATFORMCLAW_TEST_PROBE"
if command -v cygpath >/dev/null; then probe="$(cygpath -w "$probe")"; fi
export MSYS2_ARG_CONV_EXCL='*'
exec "$PLATFORMCLAW_TEST_NODE" "$probe" "$@"
`,
    { mode: 0o755 },
  );
  return {
    OPENCLAW_CONFIG_PATH: shellPath(config),
    NODE_EXTRA_CA_CERTS: undefined,
    PLATFORMCLAW_TEST_TOKEN_FILE: shellPath(token),
    PLATFORMCLAW_TEST_PROBE: shellPath(probe),
    PLATFORMCLAW_TEST_NODE: shellPath(process.execPath),
    PLATFORMCLAW_TEST_BIN: shellPath(bin),
    PLATFORMCLAW_TEST_GATEWAY: shellPath(launcher),
  };
}

function runLauncher(heap: string | undefined, options = "") {
  return runShell(
    'chmod +x "$PLATFORMCLAW_TEST_BIN/node" "$PLATFORMCLAW_TEST_BIN/docker"; export PATH="$PLATFORMCLAW_TEST_BIN:$PATH"; exec bash "$PLATFORMCLAW_TEST_GATEWAY"',
    { ...createLauncherFixture(), [heapKey]: heap, NODE_OPTIONS: options },
  );
}

function extractDeployFunctions(...names: string[]): string {
  const deploy = readFileSync(path.join(runtimeRoot, "platformclaw-deploy"), "utf8");
  return names
    .map((name) => {
      const match = deploy.match(new RegExp("^" + name + "\\(\\) \\{[\\s\\S]*?^\\}", "mu"));
      expect(match, name).not.toBeNull();
      return match![0];
    })
    .join("\n");
}

type GatewayProbe = { pid: number; options: string; limit: number; args: string[] };

describe("PlatformClaw gateway heap", () => {
  it.each([
    "",
    "--trace-warnings --max-old-space-size=256",
    "--max_old_space_size=512",
    '--max_old_space_size="1024"',
  ])(
    "applies 8192 MiB through the final gateway PID while preserving %s",
    (existing) => {
      const result = runLauncher("8192", existing);
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      const probe = JSON.parse(result.stdout) as GatewayProbe;
      expect(probe.pid).toBeGreaterThan(0);
      expect(probe.options).toBe(`${existing ? `${existing} ` : ""}--max-old-space-size=8192`);
      expect(probe.limit).toBeGreaterThanOrEqual(8192 * 1024 ** 2);
      expect(probe.limit).toBeLessThan(8704 * 1024 ** 2);
      expect(probe.args).toEqual([
        "/app/openclaw.mjs",
        "gateway",
        "--bind",
        "lan",
        "--port",
        "18789",
      ]);
    },
    30_000,
  );

  it("keeps launcher behavior outside Compose when the dedicated setting is absent", () => {
    const result = runLauncher(undefined, "--trace-warnings --max-old-space-size=512");
    expect(result.status, result.stderr).toBe(0);
    const probe = JSON.parse(result.stdout) as GatewayProbe;
    expect(probe.options).toBe("--trace-warnings --max-old-space-size=512");
    expect(probe.limit).toBeLessThan(1024 * 1024 ** 2);
  }, 30_000);

  it("does not hide a malformed existing NODE_OPTIONS value", () => {
    const result = runLauncher("8192", "--max-old-space-size 1024");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--max-old-space-size");
    expect(result.stdout).toBe("");
  });

  it.each(["0", "-1", " ", "8192 ", " 8192", "8GiB", "8192.5"])(
    "rejects invalid heap MiB %j before startup",
    (heap) => {
      const result = runLauncher(heap);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${heapKey} must be a positive integer in MiB`);
      expect(result.stdout).toBe("");
    },
  );

  it("validates heap settings before the updater changes image refs or stops Compose", () => {
    const root = tempDirs.make("platformclaw-heap-preflight-");
    const envFile = path.join(root, "deployment.env");
    const required = [
      "PLATFORMCLAW_PUBLIC_ORIGIN",
      "PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL",
      "PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_URL",
      "PLATFORMCLAW_EMPLOYEE_AUTH_CA_FILE",
      "PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE",
      "PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE",
      "PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE",
      "PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE",
      "PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE",
      "PLATFORMCLAW_KNOX_CDEP_URL",
      "PLATFORMCLAW_KNOX_WEBHOOK_SECRET_SECRET_FILE",
      "PLATFORMCLAW_KNOX_SERVICE_TOKEN_SECRET_FILE",
      "PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE",
    ].map((key) => key + "=synthetic");
    const base =
      [
        "PLATFORMCLAW_IMAGE=platformclaw:111111111111",
        "PLATFORMCLAW_SANDBOX_IMAGE=platformclaw-sandbox:111111111111",
        ...required,
      ].join("\n") + "\n";
    const functions = extractDeployFunctions(
      "read_env_value",
      "require_immutable_image_ref",
      "skillhub_enabled",
      "validate_deployment_env",
      "prepare_runtime_file_layout",
      "prepare_image_update_runtime_files",
      "apply_images",
    );
    const setup =
      functions +
      String.raw`
deploy_root="$PLATFORMCLAW_TEST_ROOT"
env_file="$deploy_root/deployment.env"
# Avoid Windows sed/tail spawn costs; the production reader has separate round-trip tests.
read_env_value() {
  local key="$1" field value result="" source_file="$env_file"
  if (( $# > 1 )); then source_file="$2"; fi
  while IFS='=' read -r field value; do
    if [[ "$field" == "$key" ]]; then result="$value"; fi
  done <"$source_file"
  printf '%s\n' "$result"
}
require_service_user() { :; }
require_main_docker() { :; }
require_rootless_docker() { :; }
image_pair_available() { :; }
docker() { :; }
rootless=(docker)
ensure_layout() { :; }
reconcile_skillhub_environment() { :; }
# Any progress into deployment mutations or Compose is a regression.
provision_ca() { echo UNEXPECTED_MUTATION; exit 91; }
record_compose() { echo UNEXPECTED_COMPOSE; exit 92; }
compose=(record_compose)
`;
    for (const heap of ["8192MiB", "0", "-1", " ", "8GiB", "8192.5"]) {
      const initial = base + heapKey + "=" + heap + "\n";
      writeFileSync(envFile, initial);
      const result = runShell(
        setup + "\napply_images platformclaw:222222222222 platformclaw-sandbox:222222222222\n",
        { PLATFORMCLAW_TEST_ROOT: shellPath(root) },
      );
      expect(result.status, result.stderr || result.error?.message).toBe(1);
      expect(result.stderr).toContain(heapKey + " must be a positive integer in MiB");
      expect(result.stdout).toBe("");
      expect(readFileSync(envFile, "utf8")).toBe(initial);
    }
    for (const heap of [undefined, "", "4096", "8192", "12288"]) {
      writeFileSync(envFile, base + (heap === undefined ? "" : heapKey + "=" + heap + "\n"));
      const result = runShell(setup + "\nvalidate_deployment_env\n", {
        PLATFORMCLAW_TEST_ROOT: shellPath(root),
      });
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      expect(result.stdout).toBe("");
    }
  }, 30_000);

  it("preserves a custom setting through the updater's image-pair update and rollback", () => {
    const root = tempDirs.make("platformclaw-heap-update-");
    const functions = extractDeployFunctions("read_env_value", "set_image_pair");
    const result = runShell(
      `${functions}
deploy_root="$PLATFORMCLAW_TEST_ROOT"
env_file="$deploy_root/deployment.env"
for heap in 4096 8192 12288; do
  printf '%s\\n' 'PLATFORMCLAW_IMAGE=platformclaw:old' 'PLATFORMCLAW_SANDBOX_IMAGE=platformclaw-sandbox:old' "${heapKey}=$heap" >"$env_file"
  cp "$env_file" "$env_file.previous"
  set_image_pair platformclaw:new platformclaw-sandbox:new
  [[ "$(read_env_value ${heapKey})" == "$heap" ]]
  [[ "$(read_env_value PLATFORMCLAW_IMAGE)" == platformclaw:new ]]
  set_image_pair "$(read_env_value PLATFORMCLAW_IMAGE "$env_file.previous")" "$(read_env_value PLATFORMCLAW_SANDBOX_IMAGE "$env_file.previous")"
  cmp "$env_file" "$env_file.previous"
done`,
      { PLATFORMCLAW_TEST_ROOT: shellPath(root) },
    );
    expect(result.status, result.stderr || result.error?.message).toBe(0);
  });

  it.skipIf(!hasCompose).each([undefined, "", "4096", "8192", "12288"])(
    "uses the deployment env value %j only for the gateway through Compose",
    (heap) => {
      const root = tempDirs.make("platformclaw-heap-compose-");
      const envFile = path.join(root, "deployment.env");
      const secret = path.join(root, "synthetic-secret");
      writeFileSync(secret, "synthetic-test-secret");
      const values = [
        "PLATFORMCLAW_SKILL_HUB_ENABLED=false",
        "PLATFORMCLAW_PUBLIC_ORIGIN=https://platformclaw.example.test",
        "PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL=https://auth.example.test/login",
        "PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_URL=https://auth.example.test/adsso",
        "PLATFORMCLAW_KNOX_CDEP_URL=https://cdep.example.test/outbound",
        ...[
          "EMPLOYEE_AUTH_CA_FILE",
          "EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE",
          "GATEWAY_TOKEN_SECRET_FILE",
          "GATEWAY_SERVICE_IDENTITY_SECRET_FILE",
          "EXECUTION_SERVICE_TOKEN_SECRET_FILE",
          "INITIAL_ADMIN_IDS_SECRET_FILE",
          "KNOX_WEBHOOK_SECRET_SECRET_FILE",
          "KNOX_SERVICE_TOKEN_SECRET_FILE",
          "SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE",
        ].map((key) => `PLATFORMCLAW_${key}=${secret.replaceAll("\\", "/")}`),
        ...(heap === undefined ? [] : [`${heapKey}=${heap}`]),
      ];
      writeFileSync(envFile, `${values.join("\n")}\n`);
      const result = runShell(
        String.raw`
getent() { printf 'platformclaw:x:1000:1000::/home/synthetic:/bin/bash\n'; }
id() { printf '1000\n'; }
export -f getent id
exec bash "$PLATFORMCLAW_TEST_COMPOSE" config --format json
`,
        {
          PLATFORMCLAW_TEST_COMPOSE: shellPath(path.join(runtimeRoot, "platformclaw-compose")),
          PLATFORMCLAW_DEPLOY_ROOT: shellPath(root),
          PLATFORMCLAW_ENV_FILE: shellPath(envFile),
          [heapKey]: "16384",
          PLATFORMCLAW_GUIDE_VIDEO_URL: "",
          PLATFORMCLAW_GUIDE_VIDEO_S3_ENDPOINT: "",
          PLATFORMCLAW_GUIDE_VIDEO_S3_BUCKET: "",
          PLATFORMCLAW_GUIDE_VIDEO_S3_KEY: "",
          PLATFORMCLAW_GUIDE_VIDEO_S3_AWS_PROFILE: "",
          PLATFORMCLAW_JIRA_VOC_CONFIG_FILE: "",
          PLATFORMCLAW_JIRA_VOC_CONFIG_HOST_FILE: "",
          WEB_FETCH_RELAY_URL: "",
          WEB_SEARCH_RELAY_URL: "",
        },
      );
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      const config = JSON.parse(result.stdout) as {
        services: Record<string, { environment?: Record<string, string> }>;
      };
      const gateway = config.services["openclaw-gateway"]!.environment!;
      expect(gateway[heapKey]).toBe(heap || "8192");
      for (const [name, service] of Object.entries(config.services)) {
        if (name !== "openclaw-gateway") {
          expect(service.environment?.[heapKey], name).toBeUndefined();
        }
      }
      const launched = runLauncher(gateway[heapKey]);
      expect(launched.status, launched.stderr).toBe(0);
      const probe = JSON.parse(launched.stdout) as GatewayProbe;
      expect(probe.options).toBe(`--max-old-space-size=${heap || "8192"}`);
      expect(probe.limit).toBeGreaterThanOrEqual(Number(heap || "8192") * 1024 ** 2);
    },
    30_000,
  );
});
