#!/usr/bin/env node
// Explicit development harness: synthetic accounts, isolated state and a controllable clock.
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadPlatformClawDeploymentConfig } from "../packages/platformclaw-control-plane/src/deployment-config.js";
import { createPlatformClawDeploymentRuntime } from "../packages/platformclaw-control-plane/src/deployment-runtime.js";
import { HORSE_RACING_MIN_BET_GOLD } from "../packages/platformclaw-control-plane/src/horse-racing-contracts.js";
import {
  HORSE_RACE_DURATION_MS,
  HORSE_RACE_LOCK_BEFORE_MS,
  horseRaceOpensAt,
  nextHorseRaceStartsAt,
} from "../packages/platformclaw-control-plane/src/horse-racing-engine.js";
import {
  createSyncKysely,
  takeFirstSync,
} from "../packages/platformclaw-control-plane/src/kysely-sync.js";
import type { HorseRacingDatabase } from "../packages/platformclaw-control-plane/src/sqlite-schema-horse-racing.js";
import {
  createPlatformClawWebIngressRuntime,
  type PlatformClawWebIngressRuntime,
} from "../packages/platformclaw-control-plane/src/web-ingress-runtime.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP_PORT = 19_301;
const CLOCK_PORT = 19_302;
const AUTH_PORT = 19_380;
const GATEWAY_PORT = 19_390;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const CLOCK_ORIGIN = `http://127.0.0.1:${CLOCK_PORT}`;
const TEST_ACCOUNTS = ["person.one", "admin.user"] as const;

function nextPreviewRace(databasePath: string): number {
  let after = Date.now();
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      // Bootstrap checks SQLite's catalog before the feature tables have been ensured.
      const hasRaces = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='horse_races'")
        .get();
      if (hasRaces) {
        const latest = takeFirstSync(
          database,
          createSyncKysely<HorseRacingDatabase>()
            .selectFrom("horse_races")
            .select("starts_at")
            .where("status", "!=", "scheduled")
            .orderBy("starts_at", "desc")
            .limit(1),
        );
        // A restarted test clock must advance past recorded rounds, preserving normal payouts/refunds.
        if (latest) {
          after = Math.max(after, latest.starts_at + HORSE_RACE_DURATION_MS);
        }
      }
    } finally {
      database.close();
    }
  }
  return nextHorseRaceStartsAt(after);
}

function options(): { stateDir: string; host: string } {
  let stateDir =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? process.cwd(), "PlatformClaw", "horse-racing-preview")
      : "/preview/horse-racing";
  let host = "127.0.0.1";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    const value = args[++index];
    if (!value || (option !== "--state-dir" && option !== "--listen-host")) {
      throw new Error(
        "Usage: node --import tsx scripts/platformclaw-racing-preview.ts [--state-dir DIR] [--listen-host 127.0.0.1|0.0.0.0]",
      );
    }
    if (option === "--state-dir") {
      stateDir = value;
    } else if (value === "127.0.0.1" || value === "0.0.0.0") {
      host = value;
    } else {
      throw new Error("Preview listen host must be 127.0.0.1 or 0.0.0.0 (isolated Docker only)");
    }
  }
  return { stateDir: resolve(stateDir), host };
}

async function assertPortFree(port: number, host: string): Promise<void> {
  const probe = createTcpServer();
  await new Promise<void>((done, reject) => {
    probe.once("error", () =>
      reject(new Error(`Preview port ${port} is occupied; existing services were left running.`)),
    );
    probe.listen(port, host, () => probe.close((error) => (error ? reject(error) : done())));
  });
}

async function waitHealthy(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Preview child stopped before ${url} became ready; inspect its preview log.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
    } catch {
      // Startup health is expected to be absent until this owned child binds its port.
    }
    await delay(250);
  }
  throw new Error(`Preview startup timed out at ${url}; inspect its preview log.`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((done) => {
      child.once("exit", () => done());
    }),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((done) => {
      child.once("exit", () => done());
    });
  }
}

async function main(): Promise<void> {
  const { stateDir, host } = options();
  for (const port of [APP_PORT, CLOCK_PORT, AUTH_PORT, GATEWAY_PORT]) {
    await assertPortFree(port, host);
  }
  const marker = join(stateDir, ".platformclaw-racing-preview");
  if (existsSync(stateDir) && !existsSync(marker)) {
    throw new Error(
      "Refusing an existing unmarked directory. Choose a new --state-dir for synthetic preview data.",
    );
  }
  for (const name of ["", "gateway", "control", "workspaces", "secrets", "home"]) {
    mkdirSync(join(stateDir, name), { recursive: true, mode: 0o700 });
  }
  writeFileSync(marker, "Synthetic horse-racing preview only\n", { mode: 0o600 });
  const secret = (name: string, generate: () => string): string => {
    const path = join(stateDir, "secrets", name);
    if (!existsSync(path)) {
      writeFileSync(path, generate(), { mode: 0o600, flag: "wx" });
    }
    return path;
  };
  const tokenFile = secret("gateway-token", () => randomBytes(32).toString("hex"));
  const keyFile = secret("credential-key", () => randomBytes(32).toString("base64"));
  const executionFile = secret("execution-token", () => randomBytes(32).toString("hex"));
  const knoxFile = secret("knox-token", () => randomBytes(32).toString("hex"));
  const adminFile = secret("admin-ids", () => "admin.user");
  const identityFile = secret("gateway-identity.pem", () =>
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const configPath = join(stateDir, "gateway", "openclaw.json");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: {
            mode: "local",
            bind: "loopback",
            auth: { mode: "token" },
            controlUi: { enabled: false },
          },
          plugins: {
            entries: {
              "admin-http-rpc": { enabled: true, hooks: { allowPromptInjection: true } },
              "platformclaw-user-mcp": { enabled: true },
            },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  // Do not inherit operator credentials or deployment configuration into this synthetic runtime.
  const databasePath = join(stateDir, "control", "control.sqlite");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    LANG: process.env.LANG,
    HOME: join(stateDir, "home"),
    USERPROFILE: join(stateDir, "home"),
    OPENCLAW_STATE_DIR: join(stateDir, "gateway"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: readFileSync(tokenFile, "utf8").trim(),
    PLATFORMCLAW_PUBLIC_ORIGIN: APP_ORIGIN,
    PLATFORMCLAW_LISTEN_HOST: host,
    PLATFORMCLAW_LISTEN_PORT: String(APP_PORT),
    PLATFORMCLAW_DATABASE_PATH: databasePath,
    PLATFORMCLAW_CONTROL_UI_ROOT: join(ROOT, "dist", "control-ui"),
    PLATFORMCLAW_PERSONAL_WORKSPACE_ROOT: join(stateDir, "workspaces"),
    PLATFORMCLAW_INITIAL_ADMIN_ACCOUNT_IDS_FILE: adminFile,
    PLATFORMCLAW_GATEWAY_URL: `ws://127.0.0.1:${GATEWAY_PORT}`,
    PLATFORMCLAW_GATEWAY_TOKEN_FILE: tokenFile,
    PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_FILE: identityFile,
    PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_FILE: keyFile,
    PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS:
      process.platform === "win32"
        ? `\\\\.\\pipe\\platformclaw-racing-preview-${APP_PORT}`
        : join(stateDir, "credential-broker.sock"),
    PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE: executionFile,
    PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE: knoxFile,
    PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL: `http://127.0.0.1:${AUTH_PORT}/login`,
  };
  let raceStartsAt = nextPreviewRace(databasePath);
  let clockBase = horseRaceOpensAt(raceStartsAt);
  let runningSince: number | null = null;
  const clockNow = () => clockBase + (runningSince === null ? 0 : Date.now() - runningSince);
  let runtime: PlatformClawWebIngressRuntime | undefined;
  let developerServer: Server | undefined;
  let bootstrapTimer: ReturnType<typeof setInterval> | undefined;
  let bootstrapInFlight: Promise<void> | undefined;
  const children: ChildProcess[] = [];
  let closing = false;
  let rejectStopped: (error: Error) => void = () => undefined;
  const stopped = new Promise<void>((done, reject) => {
    rejectStopped = reject;
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  const launch = (name: string, command: string, args: string[]) => {
    const descriptor = openSync(join(stateDir, `${name}.log`), "a", 0o600);
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
    });
    closeSync(descriptor);
    children.push(child);
    child.once("error", (error) =>
      rejectStopped(new Error(`${name} could not launch: ${error.message}`)),
    );
    child.once("exit", (code) => {
      if (!closing) {
        rejectStopped(
          new Error(
            `${name} stopped (exit ${code}); inspect ${name}.log in the preview directory.`,
          ),
        );
      }
    });
    return child;
  };
  // Attach immediately: a failed child can exit during health polling, before the final wait begins.
  void stopped.catch(() => undefined);
  try {
    const auth = launch("employee-auth", process.platform === "win32" ? "python" : "python3", [
      "scripts/mock_employee_auth.py",
      "--bind",
      "127.0.0.1",
      "--port",
      String(AUTH_PORT),
    ]);
    await waitHealthy(`http://127.0.0.1:${AUTH_PORT}/healthz`, auth, 15_000);
    const gateway = launch("gateway", process.execPath, [
      "openclaw.mjs",
      "gateway",
      "--bind",
      "loopback",
      "--port",
      String(GATEWAY_PORT),
    ]);
    await waitHealthy(`http://127.0.0.1:${GATEWAY_PORT}/healthz`, gateway, 180_000);
    const config = loadPlatformClawDeploymentConfig(env);
    runtime = createPlatformClawDeploymentRuntime(config, {
      env,
      createRuntime: (runtimeOptions) =>
        createPlatformClawWebIngressRuntime({
          ...runtimeOptions,
          racingNow: clockNow,
        }),
    });
    await runtime.prepare();
    await runtime.listen({ host, port: APP_PORT });
    const liveRuntime = runtime;
    const seeded = new Set<string>();
    const bootstrap = async () => {
      for (const accountId of TEST_ACCOUNTS) {
        if (seeded.has(accountId)) {
          continue;
        }
        const user = await liveRuntime.auth.store.getUserByAccountId(accountId);
        if (!user) {
          continue;
        }
        for (let hit = 1; hit <= 500; hit++) {
          await liveRuntime.auth.store.rewardBaseballPlateAppearance({
            userId: user.id,
            requestId: `preview-test-points-v2-${hit}`,
            outcome: "home_run",
            now: clockNow(),
          });
        }
        seeded.add(accountId);
      }
    };
    bootstrapTimer = setInterval(() => {
      bootstrapInFlight ??= bootstrap()
        .catch((error: unknown) =>
          rejectStopped(
            new Error(
              `TEST POINTS initialization failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )
        .finally(() => {
          bootstrapInFlight = undefined;
        });
    }, 1_000);
    const stage = (action: string) => {
      const current = clockNow();
      let target: number;
      if (action === "next" || action === "reset") {
        raceStartsAt = nextHorseRaceStartsAt(
          Math.max(current, raceStartsAt + HORSE_RACE_DURATION_MS),
        );
        target = horseRaceOpensAt(raceStartsAt);
      } else if (action === "open") {
        target = horseRaceOpensAt(raceStartsAt);
      } else if (action === "lock") {
        target = raceStartsAt - HORSE_RACE_LOCK_BEFORE_MS;
      } else if (action === "start") {
        target = raceStartsAt;
      } else if (action === "finish") {
        target = raceStartsAt + HORSE_RACE_DURATION_MS;
      } else {
        throw new Error("Unknown preview stage");
      }
      if (target < current) {
        throw new Error("Clock cannot move backwards. Choose the next test race.");
      }
      clockBase = target;
      runningSince = action === "start" ? Date.now() : null;
      liveRuntime.auth.store.racing.advance(clockNow());
    };
    const runDemo = async () => {
      const demoUsers = [];
      for (let index = 1; index <= 2; index++) {
        const accountId = `racing.demo.${index}`;
        const principal = await liveRuntime.auth.store.upsertPrincipal(
          {
            provider: "ldap",
            subject: accountId,
            accountId,
            employeeId: `TEST-RACING-DEMO-${index}`,
            displayName: `TEST 관전 ${index}`,
          },
          Date.now(),
        );
        demoUsers.push(principal.user);
      }
      let race = liveRuntime.auth.store.racing.snapshot(demoUsers[0].id, clockNow()).race;
      // Demo participants exist only in this synthetic harness; the viewer's wallet is never charged.
      for (let attempts = 0; attempts < 8 && race?.status !== "betting"; attempts++) {
        stage("next");
        race = liveRuntime.auth.store.racing.snapshot(demoUsers[0].id, clockNow()).race;
      }
      if (!race || race.status !== "betting") {
        throw new Error("Open a new test race before starting the demo");
      }
      for (const [index, user] of demoUsers.entries()) {
        for (let reward = 0; reward < 17; reward++) {
          await liveRuntime.auth.store.rewardBaseballPlateAppearance({
            userId: user.id,
            requestId: `demo-gold-v2-${race.id}-${reward}`,
            outcome: "hit",
            now: Date.now(),
          });
        }
        liveRuntime.auth.store.racing.placeBet(
          user.id,
          {
            requestId: `demo-ticket-${race.id}`,
            raceId: race.id,
            market: "win",
            selection: [String(index + 1)],
            amount: HORSE_RACING_MIN_BET_GOLD,
          },
          clockNow(),
        );
      }
      stage("start");
    };
    let demoInFlight: Promise<void> | null = null;
    const startDemo = () =>
      (demoInFlight ??= runDemo().finally(() => {
        demoInFlight = null;
      }));
    const handleDeveloperRequest = async (request: IncomingMessage, response: ServerResponse) => {
      if (request.headers.host !== `127.0.0.1:${CLOCK_PORT}`) {
        response.writeHead(403).end("Use the localhost developer URL");
        return;
      }
      const pathname = new URL(request.url ?? "/", CLOCK_ORIGIN).pathname;
      if (request.method === "POST") {
        if (request.headers.origin !== CLOCK_ORIGIN) {
          response.writeHead(403).end("Developer controls require the same localhost origin");
          return;
        }
        try {
          if (pathname === "/demo") {
            await startDemo();
          } else {
            if (demoInFlight) {
              throw new Error("Demo is starting; wait for it before changing stages");
            }
            stage(pathname.slice(1));
          }
          request.resume();
          response.writeHead(303, { Location: CLOCK_ORIGIN }).end();
        } catch (error) {
          response
            .writeHead(409, { "Content-Type": "text/plain; charset=utf-8" })
            .end(
              `${error instanceof Error ? error.message : "Stage failed"}\nReturn to ${CLOCK_ORIGIN}`,
            );
        }
        return;
      }
      if (request.method !== "GET" || pathname !== "/") {
        response.writeHead(404).end("Preview control not found");
        return;
      }
      const buttons = [
        ["demo", "지금 출발 · 혼자 보는 데모"],
        ["open", "베팅 접수"],
        ["lock", "마감 / 카운트다운"],
        ["start", "정각 출발 (실시간 3분)"],
        ["finish", "결과 / 정산"],
        ["next", "다음 경주"],
        ["reset", "새 경주로 초기화"],
      ];
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      });
      response.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TEST · 경마 개발 제어</title>
        <style>body{font:18px system-ui;background:#101827;color:#fff;max-width:800px;margin:48px auto;padding:24px}h1{color:#ffd166}button{font:inherit;padding:14px;margin:8px;border-radius:12px;cursor:pointer}a{color:#58a6ff}form{display:inline}</style>
        <h1>TEST · 경마 미리보기</h1><p>격리된 테스트 서버 · 가상 한국시간 · 실제 포인트가 아닙니다.</p>
        <p>가상 시각: ${new Date(clockNow()).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}<br>이번 경주: ${new Date(raceStartsAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
        <p><a href="${APP_ORIGIN}/platformclaw/login" target="_blank" rel="noopener">PlatformClaw 테스트 서버 열기</a></p>
        <p>person.one / admin.user · 비밀번호: test-password<br>최초 로그인 후 TEST POINTS 3,000G를 야구 보상 경로로 한 번 지급합니다.<br>혼자 보는 데모는 전용 테스트 참가자 2명이 참여하며, 관전자의 G를 차감하지 않습니다.<br>직접 베팅할 때는 두 계정에서 참여하세요.</p>
        ${buttons.map(([action, label]) => `<form method="post" action="/${action}"><button>${label}</button></form>`).join("")}
        <p>시간은 앞으로만 이동합니다. 새 경주는 이전 베팅을 정상 정산하거나 환불하며, 계정 잔액을 삭제하지 않습니다.</p></html>`);
    };
    developerServer = createServer((request, response) => {
      void handleDeveloperRequest(request, response).catch(() => {
        response.writeHead(500).end("TEST controls failed; return to the developer page");
      });
    });
    await new Promise<void>((done, reject) => {
      developerServer?.once("error", reject);
      developerServer?.listen(CLOCK_PORT, host, done);
    });
    console.log(`TEST preview ready: ${APP_ORIGIN}/platformclaw/login`);
    console.log(`TEST clock controls: ${CLOCK_ORIGIN}`);
    console.log(
      "Synthetic accounts: person.one / admin.user; password: test-password; TEST POINTS: 3000G each.",
    );
    await stopped;
  } finally {
    closing = true;
    clearInterval(bootstrapTimer);
    await bootstrapInFlight;
    await new Promise<void>((done) => {
      if (developerServer) {
        developerServer.close(() => done());
      } else {
        done();
      }
    });
    try {
      await runtime?.close();
    } finally {
      // A control shutdown failure must still release the auth/Gateway children this harness owns.
      for (const child of children.toReversed()) {
        await stopChild(child);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(`[racing-preview] ${error instanceof Error ? error.message : String(error)}`);
  console.error("[racing-preview] FAILED (exit 1)");
  process.exitCode = 1;
});
