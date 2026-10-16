import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../gateway-protocol/src/version.js";
import {
  ANNOUNCEMENTS_ADMIN_PATH,
  ANNOUNCEMENTS_CHANGED,
  ANNOUNCEMENTS_PATH,
  type AnnouncementAdministrationSnapshot,
} from "./announcement-contracts.js";
import { BrowserAnnouncementService } from "./browser-announcements-http.js";
import { BrowserAuthService } from "./browser-auth-service.js";
import { BrowserGatewayProxy } from "./browser-gateway-proxy.js";
import { ControlPlaneAuthorizationError } from "./contracts.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";
import { PlatformClawWebIngressServer } from "./web-ingress-server.js";
import { createFrameQueue, FakeGateway, isRecord } from "./web-ingress-test-harness.js";

const ORIGIN = "https://announcements.example.test";
let now: number;
let directory: string;
let databasePath: string;
let store: SqliteControlPlaneStore;
let auth: BrowserAuthService;
let base: string;
const tokens = new Map<string, string>();
const stores: SqliteControlPlaneStore[] = [];
const servers: PlatformClawWebIngressServer[] = [];
const sockets: WebSocket[] = [];

function openStore() {
  const value = new SqliteControlPlaneStore({
    databasePath,
    initialAdminAccountIds: ["admin.test"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  stores.push(value);
  return value;
}

function authService(database: SqliteControlPlaneStore) {
  let sequence = 0;
  return new BrowserAuthService({
    store: database,
    now: () => now,
    tokenFactory: () => `synthetic-token-${++sequence}`,
    provisioner: { provisionOrRefresh: async () => {} },
    authenticator: {
      authenticatePassword: async (credentials) => {
        const id = credentials.login.identifier;
        return {
          status: "authenticated",
          principal: {
            provider: "ldap",
            subject: id,
            accountId: id,
            employeeId: id,
            displayName: id,
            department: "Synthetic Lab",
            groups: [],
          },
          profile: {
            subject: id,
            accountId: id,
            employeeId: id,
            displayName: id,
            department: "Synthetic Lab",
            part: "Test",
            confluenceSpace: "TEST",
            notes: "",
            groups: [],
            attributes: {},
          },
        };
      },
    },
  });
}

async function start(database: SqliteControlPlaneStore, authentication: BrowserAuthService) {
  const gateway = new FakeGateway();
  const service = new BrowserAnnouncementService(authentication, database.announcements, () => now);
  const gatewayProxy = new BrowserGatewayProxy({
    authService: authentication,
    store: database,
    auditWriter: database,
    gateway,
    now: () => now,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    resolveAgentIdFromSessionKey: (key) => key.split(":")[1] ?? null,
  });
  const server = new PlatformClawWebIngressServer({
    publicOrigin: ORIGIN,
    authService: authentication,
    gateway,
    gatewayProxy,
    announcementService: service,
    loginRateLimiter: {
      check: () => ({ allowed: true, retryAfterMs: 0 }),
      recordFailure: () => {},
    },
  });
  servers.push(server);
  await server.listen({ host: "127.0.0.1", port: 0 });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service, server };
}

function request(
  user: string | null,
  path = ANNOUNCEMENTS_PATH,
  body?: unknown,
  origin: string | null = ORIGIN,
  url = base,
) {
  return fetch(`${url}${path}`, {
    headers: {
      ...(user ? { Cookie: `platformclaw_session=${tokens.get(user)}` } : {}),
      ...(origin ? { Origin: origin } : {}),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
}

const draft = () => ({
  action: "publish",
  expectedRevision: 0,
  title: "Synthetic notice",
  body: '<img src=x onerror="alert(1)">\n<script>alert(2)</script>',
  kind: "general",
  expiresAt: now + 120_000,
});

async function websocket(user: string) {
  const socket = new WebSocket(`${base.replace("http", "ws")}/platformclaw/gateway`, {
    origin: ORIGIN,
    headers: { Cookie: `platformclaw_session=${tokens.get(user)}` },
  });
  sockets.push(socket);
  const next = createFrameQueue(socket);
  await next((frame) => isRecord(frame) && frame.event === "connect.challenge");
  socket.send(
    JSON.stringify({
      type: "req",
      id: "connect",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      },
    }),
  );
  const connected = await next((frame) => isRecord(frame) && frame.id === "connect");
  expect(connected).toMatchObject({ ok: true });
  return { socket, next };
}

beforeEach(async () => {
  now = 1_800_000_000_000;
  directory = realpathSync(mkdtempSync(join(tmpdir(), "web-announcements-")));
  databasePath = join(directory, "control.sqlite");
  store = openStore();
  auth = authService(store);
  tokens.clear();
  for (const identifier of ["admin.test", "member.one", "member.two"]) {
    const login = await auth.loginPassword({ login: { identifier, password: "synthetic-only" } });
    if (login.status !== "authenticated") {
      throw new Error(login.status);
    }
    tokens.set(identifier, login.token);
  }
  base = (await start(store, auth)).base;
});

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  for (const server of servers.splice(0)) {
    await server.close();
  }
  stores.splice(0).forEach((value) => value.close());
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("web announcements through the authenticated BFF", () => {
  it("enforces administrator, active session, Origin and field boundaries without exposing audit data", async () => {
    expect((await request(null)).status).toBe(401);
    expect((await request("member.one", ANNOUNCEMENTS_ADMIN_PATH)).status).toBe(403);
    expect((await request("member.one", ANNOUNCEMENTS_ADMIN_PATH, draft())).status).toBe(403);
    for (const origin of [null, "null", "https://hostile.example.test"]) {
      expect((await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, draft(), origin)).status).toBe(
        403,
      );
      expect(
        (await request("member.one", `${ANNOUNCEMENTS_PATH}/seen`, { revision: 1 }, origin)).status,
      ).toBe(403);
    }
    expect((await request("admin.test", ANNOUNCEMENTS_PATH, draft())).status).toBe(405);
    for (const fields of [
      { title: "" },
      { title: "x".repeat(161) },
      { body: "x".repeat(8_001) },
      { kind: "html" },
      { expiresAt: now },
      { kind: "maintenance", maintenanceAt: now + 120_001 },
      { maintenanceAt: 1, kind: "maintenance", expiresAt: Infinity },
    ]) {
      expect(
        (await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, { ...draft(), ...fields })).status,
      ).toBe(400);
    }
    const spy = vi.spyOn(auth, "authenticateToken");
    const published = await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, draft());
    expect(published.status).toBe(200);
    const snapshot = await (await request("member.one")).json();
    expect(Object.keys(snapshot).toSorted()).toEqual(["announcement", "revision", "serverNow"]);
    expect(snapshot.announcement.body).toBe(draft().body);
    expect(spy).toHaveBeenLastCalledWith(tokens.get("member.one"), false);
    const member = await auth.authenticateToken(tokens.get("member.one")!, false);
    if (member.status !== "active") {
      throw new Error(member.status);
    }
    expect(() =>
      store.announcements.mutate(member.user.id, { ...draft(), expectedRevision: 1 }, now),
    ).toThrow(ControlPlaneAuthorizationError);
    await auth.logout(tokens.get("member.one")!);
    expect((await request("member.one")).status).toBe(401);
  });

  it("signals two isolated users, restores after restart, and preserves revision order for update/cancel/expiry", async () => {
    const one = await websocket("member.one");
    const two = await websocket("member.two");
    const published = (await (
      await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, draft())
    ).json()) as AnnouncementAdministrationSnapshot;
    for (const client of [one, two]) {
      expect(
        await client.next((frame) => isRecord(frame) && frame.event === ANNOUNCEMENTS_CHANGED),
      ).toMatchObject({ payload: {} });
    }
    expect(await (await request("member.one")).json()).toEqual(
      await (await request("member.two")).json(),
    );
    const stale = await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, {
      ...draft(),
      action: "update",
      expectedRevision: 0,
    });
    expect(stale.status).toBe(409);
    const updated = (await (
      await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, {
        ...draft(),
        title: "Updated",
        action: "update",
        expectedRevision: published.revision,
      })
    ).json()) as AnnouncementAdministrationSnapshot;
    expect(updated.current?.id).toBe(published.current?.id);
    expect(updated.revision).toBe(2);
    sockets.splice(0).forEach((socket) => socket.terminate());
    await servers[0]!.close();
    servers.splice(0);
    store.close();
    stores.splice(0);
    store = openStore();
    auth = authService(store);
    base = (await start(store, auth)).base;
    expect(await (await request("member.one")).json()).toMatchObject({
      revision: 2,
      announcement: { title: "Updated" },
    });
    now += 120_000;
    expect(await (await request("member.one")).json()).toMatchObject({
      revision: 2,
      announcement: null,
    });
    const cancelled = await (
      await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, {
        action: "cancel",
        expectedRevision: 2,
      })
    ).json();
    expect(cancelled).toMatchObject({
      revision: 3,
      announcement: null,
      current: { cancelled: true },
    });
    expect(
      (
        await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, {
          action: "update",
          expectedRevision: 2,
        })
      ).status,
    ).toBe(409);
    expect(
      (await store.listAuditEvents(100))
        .filter((event) => event.targetType === "web-announcement")
        .map((event) => event.eventType)
        .toSorted(),
    ).toEqual(["announcement.cancel", "announcement.publish", "announcement.update"]);
    const db = new DatabaseSync(databasePath);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    db.close();
  });

  it("claims the maintenance popup once per account/revision across shared-DB BFFs and reconnects", async () => {
    const secondStore = openStore();
    const second = await start(secondStore, authService(secondStore));
    const published = (await (
      await request("admin.test", ANNOUNCEMENTS_ADMIN_PATH, {
        ...draft(),
        kind: "maintenance",
        maintenanceAt: now + 60_000,
      })
    ).json()) as AnnouncementAdministrationSnapshot;
    const claim = { id: published.current!.id, revision: 1 };
    const results = await Promise.all([
      request("member.one", `${ANNOUNCEMENTS_PATH}/seen`, claim),
      request("member.one", `${ANNOUNCEMENTS_PATH}/seen`, claim, ORIGIN, second.base),
    ]);
    expect(
      (await Promise.all(results.map((response) => response.json())))
        .map((value) => value.show)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(await (await request("member.two", `${ANNOUNCEMENTS_PATH}/seen`, claim)).json()).toEqual(
      { show: true },
    );
    expect(
      await (
        await request("member.two", `${ANNOUNCEMENTS_PATH}/seen`, { ...claim, id: "stale" })
      ).json(),
    ).toEqual({ show: false });
    await request(
      "admin.test",
      ANNOUNCEMENTS_ADMIN_PATH,
      {
        ...draft(),
        action: "update",
        expectedRevision: 1,
        kind: "maintenance",
        maintenanceAt: now + 60_000,
      },
      ORIGIN,
      second.base,
    );
    expect(await (await request("member.one")).json()).toMatchObject({
      revision: 2,
      announcement: { revision: 2 },
    });
    expect(
      await (
        await request("member.one", `${ANNOUNCEMENTS_PATH}/seen`, { ...claim, revision: 2 })
      ).json(),
    ).toEqual({ show: true });
    const client = await websocket("member.one");
    client.socket.terminate();
    expect(
      await (
        await request(
          "member.one",
          `${ANNOUNCEMENTS_PATH}/seen`,
          { ...claim, revision: 2 },
          ORIGIN,
          second.base,
        )
      ).json(),
    ).toEqual({ show: false });
  });
});
