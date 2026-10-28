import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { EmployeeExecutionService } from "./browser-execution-service.js";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import {
  handlePlatformClawSkillHubRequest,
  PLATFORMCLAW_SKILL_HUB_PATH,
} from "./browser-skill-hub-http.js";
import {
  deriveExecutionHandoffAddress,
  PlatformClawExecutionHandoffServer,
} from "./execution-handoff-http.js";
import { ExecutionHandoffService } from "./execution-handoff-service.js";
import { HttpGatewayAdminRpcClient } from "./gateway-admin-rpc-client.js";
import { OrganizationService } from "./organization-service.js";
import { IflytekSkillHubAdapter } from "./skill-hub-adapter.js";
import { IflytekSkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import { SkillHubService } from "./skill-hub-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";
import { SshCredentialBroker } from "./ssh-credential-broker.js";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";
import { SshCredentialVault } from "./ssh-credential-vault.js";

type SshFixture = {
  host: string;
  port: number;
  adDomain: string;
  hostKey: { algorithm: string; publicKey: string; fingerprint: string };
  accounts: Array<{
    accountId: string;
    linuxAccount: string;
    targetAddress: string;
    passwordFile: string;
  }>;
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing TCP listener");
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

/** Real Gateway process and SafeConnect SSH transport; only employee login is seeded. */
export async function createSkillHubBasicVmLiveFixture() {
  const fixturePath = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_SSH_FIXTURE_FILE;
  const registryUrl = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_URL;
  const username = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_USERNAME;
  const passwordFile = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_PASSWORD_FILE;
  const tokenFile = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_TOKEN_FILE;
  if (!fixturePath || !registryUrl || !username || !passwordFile || !tokenFile) {
    throw new Error("Disposable registry and SSH fixture files are required");
  }
  const ssh = JSON.parse(await readFile(fixturePath, "utf8")) as SshFixture;
  if (ssh.accounts.length !== 2) {
    throw new Error("Two distinct SSH fixture accounts are required");
  }
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "skillhub-vm-live-")));
  const repoRoot = process.cwd();
  const workspaceRoot = path.join(directory, "workspaces");
  const socketRoot = await mkdtemp(path.join(tmpdir(), "shvm-"));
  const store = new SqliteControlPlaneStore({
    databasePath: path.join(directory, "control.sqlite"),
    initialAdminAccountIds: ["proof.admin"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  const vault = new SshCredentialVault(
    store,
    SshCredentialCipher.fromBase64(randomBytes(32).toString("base64")),
  );
  const broker = new SshCredentialBroker(path.join(socketRoot, "credentials.sock"), vault);
  const handoff = new ExecutionHandoffService(store, broker);
  const serviceToken = randomBytes(32).toString("base64url");
  const serviceTokenFile = path.join(socketRoot, "execution-token");
  const executionServer = new PlatformClawExecutionHandoffServer(
    serviceToken,
    handoff,
    deriveExecutionHandoffAddress(broker.address),
  );
  const gatewayToken = randomBytes(32).toString("base64url");
  const gatewayPort = await freePort();
  const rpcCalls: string[] = [];
  const rpc = new HttpGatewayAdminRpcClient(
    { rpcUrl: `http://127.0.0.1:${gatewayPort}/api/v1/admin/rpc`, bearerToken: gatewayToken },
    async (input, init) => {
      // Observe real transport calls without replacing dispatch or transport results.
      if (typeof init?.body === "string") {
        rpcCalls.push((JSON.parse(init.body) as { method: string }).method);
      }
      return await fetch(input, init);
    },
  );
  const adapter = new IflytekSkillHubAdapter({
    baseUrl: registryUrl,
    token: (await readFile(tokenFile, "utf8")).trim(),
    maxArchiveBytes: 1024 * 1024,
  });
  const publishLegacy = async (namespace: string, archive: Buffer, filename: string) => {
    // Seed an actual pre-cutover PUBLIC native artifact through the retired
    // public transport. Production publication must not retain this path.
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(archive)]), filename);
    form.set("visibility", "PUBLIC");
    const response = await fetch(
      new URL(`api/cli/v1/skills/${encodeURIComponent(namespace)}/publish`, registryUrl),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${(await readFile(tokenFile, "utf8")).trim()}` },
        body: form,
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw new Error(`Legacy registry fixture publication failed (${response.status})`);
    }
    await response.arrayBuffer();
  };
  const governance = new IflytekSkillHubGovernanceClient({
    baseUrl: registryUrl,
    username,
    password: (await readFile(passwordFile, "utf8")).trim(),
  });
  const authService = new BrowserAuthService({
    store,
    authenticator: {
      authenticatePassword: async () => ({
        status: "rejected",
        message: "Login is seeded for this transport proof",
      }),
    },
    provisioner: { provisionOrRefresh: async () => undefined },
  });
  const executionService = new EmployeeExecutionService({
    authService,
    store,
    credentialVault: vault,
    credentialBroker: broker,
    adminRpc: rpc,
  });
  const service = new SkillHubService({
    store,
    governance,
    organization: new OrganizationService(store),
    workspaceRoot,
    maxPackageBytes: 1024 * 1024,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    adminRpc: rpc,
    authService,
  });
  const browserOrigins = new Set(["http://proof.test"]);
  const browserServer = createServer((req, res) => {
    void handlePlatformClawSkillHubRequest(req, res, {
      service,
      readJsonBody: readBrowserJsonBody,
      isMutationOriginAllowed: (request) => browserOrigins.has(request.headers.origin ?? ""),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  const gatewayLogs: Buffer[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  const close = async () => {
    service.close();
    browserServer.closeAllConnections();
    if (browserServer.listening) {
      await new Promise<void>((resolve) => {
        browserServer.close(() => resolve());
      });
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child!.once("exit", () => resolve());
      });
      child.kill("SIGTERM");
      if (!(await Promise.race([exited.then(() => true), delay(10_000).then(() => false)]))) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await executionServer.close();
    await broker.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  };
  try {
    await writeFile(serviceTokenFile, serviceToken, { mode: 0o600 });
    const principals = [];
    for (const accountId of ["proof.admin", ...ssh.accounts.map((account) => account.accountId)]) {
      const { user } = await store.upsertPrincipal(
        { provider: "ldap", subject: accountId, accountId, employeeId: accountId, groups: [] },
        Date.now(),
      );
      const reserved = await store.reservePersonalAgent(user.id, Date.now());
      const binding = await store.transitionAgent({
        bindingId: reserved.binding.id,
        state: "active",
        changedAt: Date.now(),
      });
      const workspaceDir = path.join(workspaceRoot, binding.agentId);
      await mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const cookie = randomBytes(24).toString("base64url");
      await store.createBrowserSession({
        userId: user.id,
        tokenHash: hashBrowserSessionToken(cookie),
        createdAt: Date.now(),
      });
      principals.push({ user, binding, workspaceDir, cookie });
    }
    const [admin, author, reader] = principals;
    if (!admin || !author || !reader) {
      throw new Error("Missing fixture principals");
    }
    const endpoint = await store.createSafeConnectEndpoint({
      actorUserId: admin.user.id,
      label: "Disposable SSH transport",
      host: ssh.host,
      port: ssh.port,
      adDomain: ssh.adDomain,
      createdAt: Date.now(),
    });
    await store.approveSafeConnectHostKey({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      ...ssh.hostKey,
      approvedAt: Date.now(),
    });
    const vmHosts = [];
    for (const [index, account] of ssh.accounts.entries()) {
      const host = await store.createVmHost({
        actorUserId: admin.user.id,
        endpointId: endpoint.id,
        label: `Disposable VM ${index + 1}`,
        targetAddress: account.targetAddress,
        createdAt: Date.now(),
      });
      vmHosts.push(host);
    }
    await broker.listen();
    await executionServer.listen();
    const configPath = path.join(directory, "openclaw.json");
    await mkdir(path.join(directory, "home"));
    await writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token: gatewayToken },
          controlUi: { enabled: false },
        },
        agents: {
          defaults: {
            workspace: author.workspaceDir,
            sandbox: { mode: "all", backend: "platformclaw-execution", workspaceAccess: "rw" },
          },
          entries: Object.fromEntries(
            principals.map((principal) => [
              principal.binding.agentId,
              { workspace: principal.workspaceDir },
            ]),
          ),
        },
        plugins: {
          allow: ["admin-http-rpc", "platformclaw-execution"],
          entries: {
            "admin-http-rpc": { enabled: true },
            "platformclaw-execution": { enabled: true },
          },
        },
        // The managed deployment reconciler enables this canonical Gateway
        // upload owner; use the same product enablement for the real live proof.
        skills: { install: { allowUploadedArchives: true } },
        discovery: { mdns: { mode: "off" } },
      }),
      { mode: 0o600 },
    );
    child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "dist/index.js"),
        "gateway",
        "run",
        "--port",
        String(gatewayPort),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: path.join(directory, "home"),
          NODE_OPTIONS: "",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(directory, "state"),
          PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS: broker.address,
          PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE: serviceTokenFile,
        },
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => gatewayLogs.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => gatewayLogs.push(Buffer.from(chunk)));
    const deadline = Date.now() + 60_000;
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Built Gateway exited before readiness");
      }
      try {
        await rpc.call("commands.list", {});
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error;
        }
        await delay(100);
      }
    }
    const allocations = [];
    for (const [index, principal] of [author, reader].entries()) {
      const account = ssh.accounts[index]!;
      const profile = (await store.getPersonalExecutionProfile(principal.binding.agentId))!;
      // Exercise the production candidate SSH probe, encrypted registration,
      // and saved-connection activation; no hand-built execution metadata.
      const connected = await executionService.selectVm({
        userId: principal.user.id,
        agentId: principal.binding.agentId,
        vmHostId: vmHosts[index]!.id,
        linuxAccount: account.linuxAccount,
        password: (await readFile(account.passwordFile, "utf8")).trim(),
        expectedRevision: profile.targetRevision,
      });
      const allocation = await store.getVmAllocationForAgent(principal.binding.agentId);
      if (
        !allocation ||
        !connected.savedVms.some((connection) => connection.active && connection.status === "ready")
      ) {
        throw new Error("Real SSH registration did not activate a ready saved VM");
      }
      allocations.push(allocation);
      // Keep Basic selected while retaining the current assigned VM for the
      // explicit independent upload/download destination scenarios.
      await rpc.call("platformclaw-execution.changeTarget", {
        agentId: principal.binding.agentId,
        target: "platform_server",
        expectedRevision: connected.targetRevision,
      });
    }
    await new Promise<void>((resolve) => {
      browserServer.listen(0, "127.0.0.1", resolve);
    });
    const address = browserServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing BFF listener");
    }
    const request = (actor: "admin" | "author" | "reader", route: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${address.port}${PLATFORMCLAW_SKILL_HUB_PATH}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: `platformclaw_session=${{ admin, author, reader }[actor].cookie}`,
          origin: "http://proof.test",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return {
      store,
      service,
      executionService,
      rpc,
      rpcCalls,
      adapter,
      governance,
      publishLegacy,
      author,
      reader,
      allocations,
      request,
      close,
      browserOrigin: `http://127.0.0.1:${address.port}`,
      addBrowserOrigin: (origin: string) => browserOrigins.add(origin),
      sanitizedGatewayLogs: () =>
        Buffer.concat(gatewayLogs)
          .toString("utf8")
          .replaceAll(gatewayToken, "[REDACTED]")
          .replaceAll(serviceToken, "[REDACTED]"),
    };
  } catch (error) {
    const logs = Buffer.concat(gatewayLogs)
      .toString("utf8")
      .replaceAll(gatewayToken, "[REDACTED]")
      .replaceAll(serviceToken, "[REDACTED]");
    await close();
    throw new Error(
      `Real Gateway/SSH fixture setup failed: ${error instanceof Error ? error.message : "unknown error"}\n${logs}`,
      { cause: error },
    );
  }
}
