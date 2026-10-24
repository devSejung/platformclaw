import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const oldSha = "111111111111";
const newSha = "222222222222";
const bundledServerImage = readFileSync(
  path.resolve("docker/platformclaw-runtime/deployment.env.example"),
  "utf8",
)
  .match(/^PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=(.+)$/m)![1]!
  .trim();
const previousServerImage = `${bundledServerImage.slice(0, bundledServerImage.lastIndexOf(":"))}:aaaaaaaaaaaabbbbbbbbbbbb`;

function createUpgradeFixture(
  mode: string,
  skillHub?: { image: string; enabled?: boolean; bundleAvailable?: boolean },
) {
  const root = tempDirs.make("platformclaw-deploy-upgrade-");
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  const deployment = path.join(root, "deployment");
  const state = path.join(deployment, "data/gateway-home/.openclaw");
  for (const dir of [
    bin,
    runtime,
    state,
    path.join(deployment, "secrets"),
    path.join(deployment, "certs"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const deploy = path.join(runtime, "platformclaw-deploy");
  copyFileSync(path.resolve("docker/platformclaw-runtime/platformclaw-deploy"), deploy);
  copyFileSync(
    path.resolve("docker/platformclaw-runtime/deployment.env.example"),
    path.join(runtime, "deployment.env.example"),
  );
  const skillHubState = path.join(deployment, "data/skillhub");
  mkdirSync(skillHubState, { recursive: true });
  writeFileSync(path.join(skillHubState, "synthetic-state"), "before-upgrade\n");
  writeFileSync(path.join(state, "synthetic-state"), "before-upgrade\n");
  writeFileSync(path.join(deployment, "certs/employee-auth-ca.pem"), "synthetic-ca\n");
  for (const name of [
    "gateway-token",
    "gateway-service-identity.pem",
    "execution-service-token",
    "knox-webhook-secret",
    "knox-service-token",
    "initial-admin-ids",
    "ssh-credential-master-key",
    "employee-auth-adsso-secret",
    "skillhub-token",
    "skillhub-postgres-password",
    "skillhub-cookie-secret",
    "skillhub-bootstrap-password",
  ]) {
    writeFileSync(path.join(deployment, "secrets", name), "synthetic-test-secret\n");
  }
  const envFile = path.join(deployment, "deployment.env");
  const keys = [
    "PUBLIC_ORIGIN",
    "EMPLOYEE_AUTH_LOGIN_URL",
    "EMPLOYEE_AUTH_ADSSO_URL",
    "EMPLOYEE_AUTH_CA_FILE",
    "EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE",
    "GATEWAY_TOKEN_SECRET_FILE",
    "GATEWAY_SERVICE_IDENTITY_SECRET_FILE",
    "EXECUTION_SERVICE_TOKEN_SECRET_FILE",
    "INITIAL_ADMIN_IDS_SECRET_FILE",
    "KNOX_CDEP_URL",
    "KNOX_WEBHOOK_SECRET_SECRET_FILE",
    "KNOX_SERVICE_TOKEN_SECRET_FILE",
    "SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE",
  ];
  writeFileSync(
    envFile,
    [
      `PLATFORMCLAW_IMAGE=platformclaw:${oldSha}`,
      `PLATFORMCLAW_SANDBOX_IMAGE=platformclaw-sandbox:${oldSha}`,
      `PLATFORMCLAW_SKILL_HUB_ENABLED=${skillHub?.enabled !== false && skillHub ? "true" : "false"}`,
      ...(skillHub ? [`PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=${skillHub.image}`] : []),
      ...keys.map((key) => `PLATFORMCLAW_${key}=synthetic`),
      "",
    ].join("\n"),
  );
  const archive = path.join(root, "synthetic-image.tar");
  writeFileSync(archive, "synthetic-image-archive");
  writeFileSync(
    path.join(bin, "getent"),
    String.raw`#!/usr/bin/env bash
printf 'synthetic:x:1000:1000::%s:/bin/bash\n' "$PLATFORMCLAW_TEST_ROOT"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "id"),
    String.raw`#!/usr/bin/env bash
case "$1" in -u|-g) printf '1000\n';; -un) printf 'synthetic\n';; *) exit 99;; esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "docker"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  info) exit 0;;
  "image inspect "*)
    [[ "$PLATFORMCLAW_TEST_BUNDLE_AVAILABLE" != false || "$*" != "image inspect $PLATFORMCLAW_TEST_SERVER_IMAGE" ]]
    ;;
  "network ls "*) printf 'synthetic-skillhub\n';;
  "load --input "*) printf 'load\n' >>"$PLATFORMCLAW_TEST_ROOT/events";;
  "run "*)
    source=""; backup=""; target=""; archive=""; token=""; previous=""
    for value in "$@"; do
      if [[ "$previous" == --volume ]]; then
        case "$value" in
          *:/source:ro) source="${"$"}{value%:/source:ro}";;
          *:/backup) backup="${"$"}{value%:/backup}";;
          *:/target) target="${"$"}{value%:/target}";;
          *:/backup.tar:ro) archive="${"$"}{value%:/backup.tar:ro}";;
          *:/run/secrets/control-token) token="${"$"}{value%:/run/secrets/control-token}";;
        esac
      fi
      previous="$value"
    done
    if [[ -n "$token" ]]; then
      printf 'sk_synthetic-test-token\n' >"$token"
      printf 'after-upgrade\n' >"$PLATFORMCLAW_DEPLOY_ROOT/data/skillhub/synthetic-state"
    elif [[ -n "$source" && -n "$backup" ]]; then
      tar -C "$source" -cpf "$backup/${"$"}{!#}" .
    elif [[ -n "$target" && -n "$archive" ]]; then
      find "$target" -mindepth 1 -depth -delete
      tar -C "$target" -xpf "$archive"
    else
      echo "Unexpected Docker run: $*" >&2; exit 97
    fi
    ;;
  *) echo "Unexpected Docker call: $*" >&2; exit 98;;
esac
`,
    { mode: 0o755 },
  );
  // Real deploy control flow and filesystem backup/restore; replace only external services.
  writeFileSync(
    path.join(runtime, "platformclaw-compose"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
shift 2
probe_root="$PLATFORMCLAW_TEST_ROOT"
state="$PLATFORMCLAW_DEPLOY_ROOT/data/gateway-home/.openclaw"
event() { printf '%s\n' "$1" >>"$probe_root/events"; }
case "$*" in
  "config --environment"|"config --quiet") ;;
  down) event down; rm -f "$probe_root/running";;
  "run --rm --no-deps openclaw-gateway "*)
    [[ ! -e "$probe_root/running" ]] || exit 91
    [[ "$*" == *"doctor --fix --yes --non-interactive --repair-only"* ]] || exit 92
    event repair
    printf 'migrated\n' >"$state/synthetic-state"
    [[ "$PLATFORMCLAW_TEST_MODE" != repair-failure ]] || exit 17
    ;;
  "up -d --wait")
    if [[ "$PLATFORMCLAW_TEST_MODE" == health-failure && ! -e "$probe_root/health-failed" ]]; then
      event health-failure
      touch "$probe_root/health-failed"
      exit 18
    fi
    event ready
    touch "$probe_root/running"
    ;;
  "up -d --wait skillhub-server")
    sed -n 's/^PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=//p' "$PLATFORMCLAW_ENV_FILE" >>"$probe_root/skillhub-images"
    ;;
  "exec --no-TTY openclaw-gateway "*)
    [[ -e "$probe_root/running" ]] || exit 93
    if [[ "$*" == *"sandbox recreate --all --force"* ]]; then
      event sandboxes
      [[ "$PLATFORMCLAW_TEST_MODE" != recreate-failure ]] || exit 19
    elif [[ "$*" == *"doctor --lint --deferred --json"* ]]; then
      event diagnostics
      # Model an accepted request while diagnostics run. Rollback would discard it.
      printf 'accepted-after-ready\n' >"$state/accepted-request"
      printf '{"ok":false,"findings":[{"message":"synthetic diagnostic"}]}\n'
      [[ "$PLATFORMCLAW_TEST_MODE" != diagnostic-failure ]] || exit 1
    else
      echo "Unexpected exec: $*" >&2; exit 94
    fi
    ;;
  *) echo "Unexpected Compose call: $*" >&2; exit 95;;
esac
`,
    { mode: 0o755 },
  );
  return { root, bin, deploy, deployment, state, skillHubState, envFile, archive, mode, skillHub };
}

describe.skipIf(process.platform === "win32")("PlatformClaw image update lifecycle", () => {
  it.each([
    ["set", newSha],
    ["update", newSha],
    ["set", oldSha],
    ["update", oldSha],
  ])("opens services and refreshes sandboxes for image %s targeting %s", (command, targetSha) => {
    const fixture = createUpgradeFixture("success");
    const result = runUpgrade(fixture, command, targetSha);
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(readEvents(fixture)).toEqual([
      ...(command === "update" ? ["load", "load"] : []),
      "down",
      "repair",
      "ready",
      "sandboxes",
      "diagnostics",
    ]);
    expect(readFileSync(path.join(fixture.state, "synthetic-state"), "utf8")).toBe("migrated\n");
    expect(readFileSync(path.join(fixture.state, "accepted-request"), "utf8")).toBe(
      "accepted-after-ready\n",
    );
    expect(readFileSync(fixture.envFile, "utf8")).toContain(
      `PLATFORMCLAW_SANDBOX_IMAGE=platformclaw-sandbox:${targetSha}`,
    );
  });

  it("retains new refs and accepted requests when online diagnostics report findings", () => {
    const fixture = createUpgradeFixture("diagnostic-failure");
    const result = runUpgrade(fixture);
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stderr).toMatch(/diagnostic/iu);
    expect(readEvents(fixture)).toEqual(["down", "repair", "ready", "sandboxes", "diagnostics"]);
    expect(readFileSync(fixture.envFile, "utf8")).toContain(
      `PLATFORMCLAW_IMAGE=platformclaw:${newSha}`,
    );
    expect(readFileSync(path.join(fixture.state, "accepted-request"), "utf8")).toBe(
      "accepted-after-ready\n",
    );
    expect(existsSync(path.join(fixture.root, "running"))).toBe(true);
  });

  it.each(["repair-failure", "health-failure", "recreate-failure"])(
    "restores old state and images after %s",
    (mode) => {
      const fixture = createUpgradeFixture(mode);
      const result = runUpgrade(fixture);
      expect(result.status, result.stderr || result.error?.message).toBe(1);
      expect(readEvents(fixture)).toEqual([
        "down",
        "repair",
        ...(mode === "health-failure" ? ["health-failure"] : []),
        ...(mode === "recreate-failure" ? ["ready", "sandboxes"] : []),
        "down",
        "ready",
      ]);
      expect(readFileSync(fixture.envFile, "utf8")).toContain(
        `PLATFORMCLAW_IMAGE=platformclaw:${oldSha}`,
      );
      expect(readFileSync(path.join(fixture.state, "synthetic-state"), "utf8")).toBe(
        "before-upgrade\n",
      );
      expect(existsSync(path.join(fixture.state, "accepted-request"))).toBe(false);
      expect(existsSync(path.join(fixture.root, "running"))).toBe(true);
      expect(result.stdout).not.toContain("PlatformClaw updated:");
    },
  );

  it.each(["platformclaw-skillhub-server:6e133c006e49", previousServerImage])(
    "advances managed SkillHub %s only after retaining its rollback environment",
    (image) => {
      const fixture = createUpgradeFixture("success", { image });
      const result = runUpgrade(fixture, "update", oldSha);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(fixture.envFile, "utf8")).toContain(
        `PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=${bundledServerImage}`,
      );
      expect(readFileSync(`${fixture.envFile}.previous`, "utf8")).toContain(
        `PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=${image}`,
      );
      expect(readFileSync(path.join(fixture.root, "skillhub-images"), "utf8")).toBe(
        `${bundledServerImage}\n`,
      );
      expect(readFileSync(path.join(fixture.skillHubState, "synthetic-state"), "utf8")).toBe(
        "after-upgrade\n",
      );
    },
  );

  it("restores the prior SkillHub image and pre-update storage after health failure", () => {
    const fixture = createUpgradeFixture("health-failure", { image: previousServerImage });
    const result = runUpgrade(fixture, "update", oldSha);
    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(readFileSync(path.join(fixture.root, "skillhub-images"), "utf8")).toBe(
      `${bundledServerImage}\n`,
    );
    expect(readFileSync(fixture.envFile, "utf8")).toContain(
      `PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=${previousServerImage}`,
    );
    expect(readFileSync(path.join(fixture.skillHubState, "synthetic-state"), "utf8")).toBe(
      "before-upgrade\n",
    );
    expect(existsSync(path.join(fixture.root, "running"))).toBe(true);
  });

  it.each([
    { image: bundledServerImage },
    { image: "registry.example.invalid/custom:abcdef012345" },
    { image: `platformclaw-skillhub-server@sha256:${"a".repeat(64)}` },
    { image: "platformclaw-skillhub-server:aaaaaaaaaaaaaaaa" },
    { image: previousServerImage, enabled: false },
    { image: previousServerImage, bundleAvailable: false },
  ])("preserves an unchanged or operator-owned SkillHub selection: %j", (skillHub) => {
    const fixture = createUpgradeFixture("success", skillHub);
    const result = runUpgrade(fixture, "set", oldSha);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(fixture.envFile, "utf8")).toContain(
      `PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=${skillHub.image}`,
    );
    expect(existsSync(`${fixture.envFile}.previous`)).toBe(false);
  });
});

function readEvents(fixture: ReturnType<typeof createUpgradeFixture>) {
  return readFileSync(path.join(fixture.root, "events"), "utf8").trim().split("\n");
}

function runUpgrade(
  fixture: ReturnType<typeof createUpgradeFixture>,
  command = "set",
  targetSha = newSha,
) {
  return spawnSync(
    "bash",
    [
      fixture.deploy,
      "image",
      command,
      ...(command === "update" ? [fixture.archive] : []),
      `platformclaw:${targetSha}`,
      `platformclaw-sandbox:${targetSha}`,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        PLATFORMCLAW_SERVICE_USER: "synthetic",
        PLATFORMCLAW_DEPLOY_ROOT: fixture.deployment,
        PLATFORMCLAW_ENV_FILE: fixture.envFile,
        PLATFORMCLAW_TEST_ROOT: fixture.root,
        PLATFORMCLAW_TEST_MODE: fixture.mode,
        PLATFORMCLAW_TEST_BUNDLE_AVAILABLE: String(fixture.skillHub?.bundleAvailable !== false),
        PLATFORMCLAW_TEST_SERVER_IMAGE: bundledServerImage,
      },
    },
  );
}
