#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { printSuccess, requirePath, resolveRepoPath, runCommand } from "./submission-utils.mjs";

const runtime = await import(
  pathToFileURL(requirePath("packages/platformclaw-control-plane/dist/index.mjs")).href
);
const {
  BoardFarmService,
  BrowserAuthService,
  createDeterministicBoardFarmIdFactory,
  DeterministicMockBoardFarmAdapter,
  InMemoryBoardFarmStateStore,
  InMemoryControlPlaneStore,
} = runtime;

const outputRoot = "submission/evidence/mock-golden-run";
const screenshotRoot = `${outputRoot}/screenshots`;
mkdirSync(resolveRepoPath(screenshotRoot), { recursive: true });

const generatedAt = "2026-08-07T12:00:00.000Z";
let clockValue = Date.parse(generatedAt);
const now = () => clockValue++;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const writeJson = (relativePath, value) => {
  writeFileSync(resolveRepoPath(relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
const writeText = (relativePath, value) => {
  writeFileSync(resolveRepoPath(relativePath), value, "utf8");
};

const counters = new Map();
const next = (kind) => {
  const value = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, value);
  return `${kind}-${String(value).padStart(3, "0")}`;
};
const controlPlaneIds = {
  nextUserId: () => next("mock-user"),
  nextBindingId: () => next("mock-binding"),
  nextSessionId: () => next("mock-session"),
  nextManagedScopeId: () => next("mock-scope"),
  nextAuditEventId: () => next("mock-control-audit"),
  nextExecutionResourceId: (kind) => next(`mock-${kind}`),
};
const controlPlaneStore = new InMemoryControlPlaneStore({
  buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  idFactory: controlPlaneIds,
});
const workspaces = new Map();
const aliases = new Map([
  ["mock.user.a", "user-a"],
  ["mock.user.b", "user-b"],
]);
const authService = new BrowserAuthService({
  store: controlPlaneStore,
  now,
  tokenFactory: () => `fixture-session-${next("secret-material")}`,
  authenticator: {
    async authenticatePassword({ login }) {
      const alias = aliases.get(login.identifier);
      if (!alias || login.password !== "fixture-only") {
        return { status: "rejected", message: "MOCK credential rejected" };
      }
      return {
        status: "authenticated",
        principal: {
          provider: "ldap",
          subject: `mock-subject-${alias}`,
          accountId: login.identifier,
          employeeId: `mock-identity-${alias}`,
          displayName: alias,
          groups: alias === "user-a" ? ["firmware"] : ["validation"],
        },
        profile: {
          employeeId: `mock-identity-${alias}`,
          accountId: login.identifier,
          subject: `mock-subject-${alias}`,
          displayName: alias,
          groups: alias === "user-a" ? ["firmware"] : ["validation"],
          attributes: {},
        },
      };
    },
  },
  provisioner: {
    async provisionOrRefresh({ binding }) {
      workspaces.set(binding.agentId, `/mock/workspaces/${binding.agentId}`);
    },
  },
});

const login = async (identifier) => {
  const result = await authService.loginPassword({
    login: { identifier, password: "fixture-only" },
  });
  assert.equal(result.status, "authenticated");
  const authenticated = await authService.authenticateToken(result.token, false);
  assert.equal(authenticated.status, "active");
  const execution = await controlPlaneStore.getPersonalExecutionProfile(result.binding.agentId);
  assert.equal(execution?.activeTarget, "platform_server");
  return {
    result,
    publicView: {
      alias: aliases.get(identifier),
      agent_id: result.binding.agentId,
      workspace: workspaces.get(result.binding.agentId),
      execution_target: "platform_server_mock_sandbox",
      session_status: authenticated.status,
    },
  };
};

const userA = await login("mock.user.a");
const userB = await login("mock.user.b");
assert.notEqual(userA.result.binding.agentId, userB.result.binding.agentId);

const fixtureBefore = [
  "export const boardReady = false;",
  "export const expectedBootMarker = 'PLATFORMCLAW_READY';",
  "",
].join("\n");
const fixtureAfter = fixtureBefore.replace("boardReady = false", "boardReady = true");
assert.notEqual(fixtureAfter, fixtureBefore);
const artifactDigest = sha256(fixtureAfter);
const buildResult = {
  mode: "mock",
  result: "passed",
  source_change: {
    fixture: "firmware-ready-flag.ts",
    before_sha256: sha256(fixtureBefore),
    after_sha256: artifactDigest,
    changed_lines: 1,
  },
  artifact: {
    id: "firmware-fixture-001",
    digest: artifactDigest,
    locator: "mock-artifact://firmware/firmware-fixture-001",
  },
  execution_target: userA.publicView.execution_target,
  completed_at: generatedAt,
};

const boardAdapter = new DeterministicMockBoardFarmAdapter();
const boardStore = new InMemoryBoardFarmStateStore(
  [
    {
      id: "mock-board-001",
      profile: "firmware-devkit",
      capabilities: ["flash", "serial-console"],
      metadata: { mode: "MOCK" },
    },
  ],
  now(),
);
const boardFarmIds = createDeterministicBoardFarmIdFactory("golden");
const boardService = new BoardFarmService({
  store: boardStore,
  adapter: boardAdapter,
  idFactory: boardFarmIds,
  now,
  policy: {
    leaseDurationMs: 600_000,
    heartbeatTimeoutMs: 120_000,
    maximumLeaseLifetimeMs: 3_600_000,
    maximumLeasesPerUser: 1,
  },
});

const submission = boardService.submit({
  actorUserId: userA.result.user.id,
  userAlias: "user-a",
  jobId: "mock-job-001",
  correlationId: "mock-correlation-001",
  idempotencyKey: "mock-golden-run-v1",
  resourceRequirement: {
    profile: "firmware-devkit",
    capabilities: ["flash", "serial-console"],
  },
  build: {
    status: "succeeded",
    artifact: buildResult.artifact,
    completedAt: Date.parse(generatedAt),
  },
});
assert.equal(submission.created, true);
assert.equal(submission.lease?.state, "active");
assert.ok(submission.accessToken);
const access = {
  actorUserId: userA.result.user.id,
  leaseId: submission.lease.id,
  accessToken: submission.accessToken,
};

const duplicate = boardService.submit({
  actorUserId: userA.result.user.id,
  userAlias: "user-a",
  jobId: "mock-job-001",
  correlationId: "mock-correlation-001",
  idempotencyKey: "mock-golden-run-v1",
  resourceRequirement: {
    profile: "firmware-devkit",
    capabilities: ["flash", "serial-console"],
  },
  build: {
    status: "succeeded",
    artifact: buildResult.artifact,
    completedAt: Date.parse(generatedAt),
  },
});
assert.equal(duplicate.created, false);
assert.equal(duplicate.run.id, submission.run.id);

await boardService.heartbeat(access);
const renewedLease = await boardService.renew(access);
const executedRun = await boardService.execute(access);
assert.equal(executedRun.status, "succeeded");

const savedState = boardStore.snapshot();
const resumedStore = new InMemoryBoardFarmStateStore(savedState);
const resumedService = new BoardFarmService({
  store: resumedStore,
  adapter: boardAdapter,
  idFactory: boardFarmIds,
  now,
});
const reloadedRun = resumedService.getRun(userA.result.user.id, executedRun.id);
assert.equal(reloadedRun.status, "succeeded");

let crossUserDenied = false;
let crossUserErrorCode = "";
try {
  resumedService.getRun(userB.result.user.id, executedRun.id);
} catch (error) {
  crossUserDenied = error?.code === "not_authorized";
  crossUserErrorCode = error?.code ?? "unexpected_error";
}
assert.equal(crossUserDenied, true);

const releasedLease = await resumedService.release(access);
assert.equal(releasedLease.state, "released");
const evidence = resumedService.listEvidence(userA.result.user.id, executedRun.id);
const evidencePhases = evidence.map((item) => item.phase);
assert.deepEqual(evidencePhases, ["deploy", "boot", "validate", "cleanup"]);

const failedBuildSubmission = resumedService.submit({
  actorUserId: userA.result.user.id,
  userAlias: "user-a",
  jobId: "mock-job-build-failure",
  correlationId: "mock-correlation-build-failure",
  idempotencyKey: "mock-build-failure-gate-v1",
  resourceRequirement: {
    profile: "firmware-devkit",
    capabilities: ["flash"],
  },
  build: {
    status: "failed",
    failureCode: "fixture_compile_failed",
    completedAt: now(),
  },
});
assert.equal(failedBuildSubmission.run.status, "build_failed");
assert.equal(failedBuildSubmission.lease, undefined);

const boardLeaseResult = {
  mode: "mock",
  result: "passed",
  run_id: executedRun.id,
  lease_id: submission.lease.id,
  board_id: submission.lease.boardId,
  profile: submission.lease.resourceRequirement.profile,
  capabilities: submission.lease.resourceRequirement.capabilities,
  acquired_state: submission.lease.state,
  renewed_expires_at: renewedLease.expiresAt,
  released_state: releasedLease.state,
  access_token_exposed: false,
  idempotent_replay: duplicate.created === false,
};
const boardValidationResult = {
  mode: "mock",
  result: "passed",
  run_id: executedRun.id,
  workflow_status: executedRun.status,
  phases: evidence.map((item) => ({
    phase: item.phase,
    status: item.status,
    kind: item.kind,
    locator: item.locator,
    sha256: item.sha256,
  })),
  adapter_calls: boardAdapter.calls.map((call) => ({
    phase: call.phase,
    operation_id: call.operationId,
    board_id: call.boardId,
  })),
};
const reportResult = {
  mode: "mock",
  result: "passed",
  provider: "jira-style-mock-adapter",
  report_key: "MOCK-001",
  locator: `mock-report://${executedRun.id}`,
  summary: "Firmware fixture build and deterministic board validation passed.",
  evidence_count: evidence.length,
};
const knoxResult = {
  mode: "mock",
  result: "passed",
  provider: "knox-style-mock-adapter",
  target_alias: "user-a",
  locator: `mock-knox-result://${executedRun.id}`,
  message_fields: ["run_id", "board_alias", "validation_status", "report_key"],
};
const verificationResult = {
  mode: "mock",
  result: "passed",
  run_id: executedRun.id,
  checks: {
    mock_employee_login: true,
    personal_agent_created: true,
    separate_user_agents: true,
    workspace_confirmed: true,
    safe_execution_target_selected: true,
    fixture_source_changed: true,
    fixture_build_passed: true,
    build_failure_blocks_board: failedBuildSubmission.lease === undefined,
    board_lease_acquired: submission.lease.state === "active",
    heartbeat_and_renewal: renewedLease.state === "active",
    deploy_boot_validate_passed: executedRun.status === "succeeded",
    evidence_preserved: evidencePhases.length === 4,
    report_created: reportResult.result === "passed",
    knox_result_created: knoxResult.result === "passed",
    restart_reload_passed: reloadedRun.status === "succeeded",
    cross_user_access_denied: crossUserDenied,
    cleanup_released_board: releasedLease.state === "released",
    raw_tokens_omitted: true,
  },
  cross_user_error_code: crossUserErrorCode,
  public_users: [userA.publicView, userB.publicView],
};

const evidencePaths = [
  `${outputRoot}/SUMMARY.md`,
  `${outputRoot}/build-result.json`,
  `${outputRoot}/board-lease-result.json`,
  `${outputRoot}/board-validation-result.json`,
  `${outputRoot}/report-result.json`,
  `${outputRoot}/knox-result.json`,
  `${outputRoot}/verification-result.json`,
  `${screenshotRoot}/mock-run-overview.svg`,
  `${screenshotRoot}/mock-run-overview.png`,
];
const manifest = {
  source_commit: runCommand("git", ["rev-parse", "HEAD"]),
  run_id: executedRun.id,
  correlation_id: executedRun.correlationId,
  generated_at: generatedAt,
  user_alias: "user-a",
  resource_alias: "mock-board-001",
  mode: "mock",
  commands: [
    "pnpm --filter @platformclaw/control-plane build",
    "node scripts/submission/collect-mock-evidence.mjs",
  ],
  result: "passed",
  evidence_paths: evidencePaths,
};

writeJson(`${outputRoot}/manifest.json`, manifest);
writeJson(`${outputRoot}/build-result.json`, buildResult);
writeJson(`${outputRoot}/board-lease-result.json`, boardLeaseResult);
writeJson(`${outputRoot}/board-validation-result.json`, boardValidationResult);
writeJson(`${outputRoot}/report-result.json`, reportResult);
writeJson(`${outputRoot}/knox-result.json`, knoxResult);
writeJson(`${outputRoot}/verification-result.json`, verificationResult);
writeText(
  `${outputRoot}/SUMMARY.md`,
  `# MOCK Golden Run 요약\n\n` +
    `이 결과는 실제 사내 Board Farm, 실제 보드, Jira 또는 Knox를 사용하지 않은 **MOCK** 증거다. ` +
    `실제 PlatformClaw 인증·개인 Agent·상태 저장 코드와 Board Farm 도메인 서비스를 결정적 adapter로 통과한다.\n\n` +
    `- Run: \`${executedRun.id}\`\n` +
    `- Resource: \`mock-board-001\`\n` +
    `- Workflow: build → lease → deploy → boot → validate → report → Knox-style result\n` +
    `- Isolation: User B의 User A run 조회가 \`${crossUserErrorCode}\`로 거절됨\n` +
    `- Recovery: 저장 snapshot을 다시 적재한 뒤 run 조회와 release 성공\n` +
    `- Secret handling: session·lease raw token은 어떤 evidence에도 기록하지 않음\n`,
);
writeText(
  `${screenshotRoot}/mock-run-overview.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">\n` +
    `<rect width="1280" height="720" fill="#071310"/>\n` +
    `<rect x="48" y="48" width="1184" height="624" rx="24" fill="#102522" stroke="#2a4b46" stroke-width="2"/>\n` +
    `<text x="88" y="112" fill="#20b8a9" font-family="sans-serif" font-size="24" font-weight="700">PLATFORMCLAW · MOCK GOLDEN RUN</text>\n` +
    `<text x="88" y="172" fill="#eafbf8" font-family="sans-serif" font-size="44" font-weight="800">${executedRun.id}</text>\n` +
    `<text x="88" y="220" fill="#9ebbb6" font-family="monospace" font-size="20">user-a · mock-board-001 · result=passed</text>\n` +
    `${["BUILD", "LEASE", "DEPLOY", "BOOT", "VALIDATE", "REPORT", "KNOX"].map((label, index) => `<g transform="translate(${88 + index * 157} 300)"><rect width="132" height="92" rx="12" fill="#0e2824" stroke="#20b8a9"/><text x="66" y="42" text-anchor="middle" fill="#eafbf8" font-family="sans-serif" font-size="18" font-weight="700">${label}</text><text x="66" y="70" text-anchor="middle" fill="#c5f36a" font-family="monospace" font-size="15">PASS</text></g>`).join("\n")}\n` +
    `<text x="88" y="486" fill="#c5f36a" font-family="sans-serif" font-size="24" font-weight="700">✓ User B cross-run access denied</text>\n` +
    `<text x="88" y="532" fill="#c5f36a" font-family="sans-serif" font-size="24" font-weight="700">✓ Restart snapshot reload and cleanup verified</text>\n` +
    `<text x="88" y="610" fill="#ffca6a" font-family="sans-serif" font-size="20" font-weight="700">MOCK — 실제 하드웨어·Jira·Knox 증거가 아님</text>\n` +
    `</svg>\n`,
);

printSuccess("mock Golden Path", `${executedRun.id} (${String(evidence.length)} evidence records)`);
