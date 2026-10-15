import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionsFilesDownloadHandlers } from "./server-methods/sessions-files-download.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import * as workspaceFs from "./server-methods/workspace-fs.js";

const METHOD = "sessions.files.download";
const bytes = Buffer.from([0, 0xff, 0x80, 1, 10]);

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function client(user?: string, admin = false): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: admin ? ["operator.admin"] : ["operator.read"],
    },
    ...(user
      ? {
          authenticatedUserId: user,
          authenticatedUserProfile: {
            profileId: user,
            displayName: user,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

type DownloadFixture = {
  sessionKey: string;
  entry: SessionEntry;
  save(entry: SessionEntry): Promise<unknown>;
  dispatch(caller: GatewayClient): Promise<Mock<RespondFn>>;
};

async function withDownloadFixture(run: (fixture: DownloadFixture) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await fs.mkdir(state.workspaceDir, { recursive: true });
    const workspace = await fs.realpath(state.workspaceDir);
    await fs.writeFile(path.join(workspace, "download.bin"), bytes);
    const sessionKey = "agent:main:download-authorization";
    const scope = { agentId: "main", sessionKey };
    const entry: SessionEntry = {
      sessionId: "download-original",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", id: "owner" },
      spawnedWorkspaceDir: workspace,
      spawnedCwd: workspace,
    };
    const save = (current: SessionEntry) => upsertSessionEntry(scope, current);
    await save(entry);
    await run({
      sessionKey,
      entry,
      save,
      async dispatch(caller) {
        const respond = vi.fn<RespondFn>();
        const terminalRespond: RespondFn = Object.assign(respond, {
          async withCompletion(...args: Parameters<RespondFn>) {
            respond(...args);
          },
        });
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "download-auth",
            method: METHOD,
            params: { ...scope, path: "download.bin" },
          },
          client: caller,
          isWebchatConnect: () => false,
          respond: terminalRespond,
          context: {
            getRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as unknown as GatewayRequestContext,
          extraHandlers: sessionsFilesDownloadHandlers,
        });
        return respond;
      },
    });
  });
}

describe("workspace downloads through Gateway authorization", () => {
  it.each([
    { name: "draft owner", user: "owner", visibility: "draft", allowed: true },
    { name: "draft admin", user: "admin", admin: true, visibility: "draft", allowed: true },
    { name: "identity-less solo", visibility: "draft", allowed: true },
    { name: "shared viewer", user: "viewer", visibility: "shared", allowed: true },
    { name: "read-only viewer", user: "viewer", visibility: "read-only", allowed: true },
    { name: "suggest viewer", user: "viewer", visibility: "suggest", allowed: true },
    { name: "foreign draft", user: "viewer", visibility: "draft", allowed: false },
    { name: "draft member", user: "member", member: true, visibility: "draft", allowed: false },
    {
      name: "incognito owner",
      user: "owner",
      incognito: true,
      visibility: "shared",
      allowed: false,
    },
    {
      name: "incognito viewer",
      user: "viewer",
      incognito: true,
      visibility: "shared",
      allowed: false,
    },
    {
      name: "incognito admin",
      user: "admin",
      admin: true,
      incognito: true,
      visibility: "shared",
      allowed: true,
    },
    { name: "incognito solo", incognito: true, visibility: "shared", allowed: true },
  ] as const)("preserves $name access", async (scenario) => {
    await withDownloadFixture(async (f) => {
      await f.save({
        ...f.entry,
        visibility: scenario.visibility,
        ...("incognito" in scenario ? { incognito: true } : {}),
      });
      if ("member" in scenario) {
        addSessionMember(
          { agentId: "main", sessionKey: f.sessionKey },
          { identityId: "member", addedBy: "owner", expectedSessionId: f.entry.sessionId },
        );
      }
      const read = vi.spyOn(workspaceFs, "readWorkspaceFile");
      const respond = await f.dispatch(
        client("user" in scenario ? scenario.user : undefined, "admin" in scenario),
      );
      expect(respond).toHaveBeenCalledTimes(1);
      if (scenario.allowed) {
        expect(read).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            sessionKey: f.sessionKey,
            file: expect.objectContaining({ contentBase64: bytes.toString("base64") }),
          }),
        );
      } else {
        expect(read).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            ...("incognito" in scenario
              ? { message: `Incognito session "${f.sessionKey}" was not found.` }
              : { details: expect.objectContaining({ code: "SESSION_READ_DENIED" }) }),
          }),
        );
      }
    });
  });

  it.each(["draft", "incognito", "replacement", "admin-replacement"] as const)(
    "withholds bytes when %s authority changes during the asynchronous read",
    async (change) => {
      await withDownloadFixture(async (f) => {
        const read = workspaceFs.readWorkspaceFile;
        vi.spyOn(workspaceFs, "readWorkspaceFile").mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          await f.save({
            ...f.entry,
            updatedAt: 2,
            ...(change === "draft" ? { visibility: "draft" } : {}),
            ...(change === "incognito" ? { incognito: true } : {}),
            ...(change.endsWith("replacement") ? { sessionId: "download-replaced" } : {}),
          });
          return result;
        });
        const respond = await f.dispatch(client("viewer", change === "admin-replacement"));
        expect(respond).toHaveBeenCalledTimes(1);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            ...(change === "incognito"
              ? { message: `Incognito session "${f.sessionKey}" was not found.` }
              : {
                  details: expect.objectContaining({
                    code:
                      change === "draft"
                        ? "SESSION_READ_DENIED"
                        : "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                  }),
                }),
          }),
        );
        expect(respond.mock.calls.some(([ok]) => ok)).toBe(false);
      });
    },
  );
});
