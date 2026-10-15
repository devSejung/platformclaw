import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import * as mediaMime from "@openclaw/media-core/mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResponseFrame,
  SessionsFilesDownloadResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import { sessionsFilesDownloadHandlers } from "./sessions-files-download.js";
import {
  createSessionEntryFixture,
  createSessionFilesHandlerInvoker,
  createWorkspaceFixture,
  expectError,
  expectOkPayload,
} from "./sessions-files.test-support.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import * as workspaceFs from "./workspace-fs.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntryReadOnly: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));
vi.mock("../session-utils.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

const invoke = createSessionFilesHandlerInvoker(sessionsFilesDownloadHandlers);
const params = { sessionKey: "agent:main:main", path: "file.bin" };
const bytes = Buffer.from([0, 0xff, 0x80, 1, 10]);

function invokeWithResponse(
  respond: RespondFn,
  authorization?: GatewayRequestHandlerOptions["sessionMutationAuthorization"],
  request = { id: "download", params },
) {
  return sessionsFilesDownloadHandlers["sessions.files.download"]!({
    req: { type: "req", ...request, method: "sessions.files.download" },
    params: request.params,
    respond,
    client: null,
    context: {} as GatewayRequestHandlerOptions["context"],
    isWebchatConnect: () => false,
    sessionMutationAuthorization: authorization,
  });
}

async function invokeFrame(id: string, requestParams = params): Promise<ResponseFrame> {
  const frames: ResponseFrame[] = [];
  const respond: RespondFn = (ok, payload, error) => {
    frames.push({ type: "res", id, ok, payload, error });
  };
  respond.withCompletion = async (...args) => respond(...args);
  await invokeWithResponse(respond, undefined, { id, params: requestParams });
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

function requestedPlacement(): WorkerSessionPlacementRecord {
  return {
    sessionId: "download-session",
    agentId: "main",
    sessionKey: params.sessionKey,
    state: "requested",
    generation: 1,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
  };
}

describe("session workspace downloads", () => {
  let workspace: string;
  let outside: string;
  let loaded: ReturnType<typeof createSessionEntryFixture>;

  beforeEach(() => {
    vi.clearAllMocks();
    workspace = createWorkspaceFixture("workspace-download-rpc-");
    outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "download-outside-"));
    fs.writeFileSync(path.join(workspace, params.path), bytes);
    fs.writeFileSync(path.join(outside, "private.bin"), "outside synthetic workspace");
    loaded = createSessionEntryFixture(workspace, "download-session");
    mocks.loadSessionEntryReadOnly.mockImplementation(() => loaded);
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue(workspace);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("returns original binary bytes without the preview text conversion", async () => {
    const result = expectOkPayload(
      await invoke("sessions.files.download", params),
    ) as SessionsFilesDownloadResult;
    expect(result).toEqual({
      sessionKey: params.sessionKey,
      file: {
        path: params.path,
        name: "file.bin",
        size: bytes.length,
        mimeType: "application/octet-stream",
        contentBase64: bytes.toString("base64"),
      },
    });
    expect(Buffer.from(result.file.contentBase64, "base64")).toEqual(bytes);
  });

  it.each([0, 300 * 1024])("downloads a Unicode-named text file with %i bytes", async (size) => {
    const name = "한글 파일.txt";
    const content = Buffer.alloc(size, 0x61);
    fs.writeFileSync(path.join(workspace, name), content);
    const result = expectOkPayload(
      await invoke("sessions.files.download", { ...params, path: name }),
    ) as SessionsFilesDownloadResult;
    expect(result.file).toMatchObject({ path: name, name, size, mimeType: "text/plain" });
    expect(Buffer.from(result.file.contentBase64, "base64")).toEqual(content);
  });

  it("accepts exactly 16 MiB and keeps the complete wire response below the WebSocket limit", async () => {
    const content = Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES, 0xa5);
    fs.writeFileSync(path.join(workspace, params.path), content);
    const result = expectOkPayload(
      await invoke("sessions.files.download", params),
    ) as SessionsFilesDownloadResult;
    const decoded = Buffer.from(result.file.contentBase64, "base64");
    expect(result.file.size).toBe(MAX_TERMINAL_UPLOAD_BYTES);
    expect(createHash("sha256").update(decoded).digest("hex")).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    const frame = { type: "res", id: "download", ok: true, payload: result };
    expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  it.each([
    ["ASCII", "i"],
    ["JSON-escaped", '\0"\\'],
    ["UTF-8", "한😀"],
  ])(
    "enforces the exact success-frame budget for a large %s ID before reading",
    async (_, token) => {
      const requestParams = { sessionKey: 'agent:main:메타"\\\n', path: "한글 파일.bin" };
      fs.writeFileSync(
        path.join(workspace, requestParams.path),
        Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES),
      );
      // The public MIME field permits 256 characters, each potentially JSON-escaped.
      const mimeType = "\0".repeat(256);
      vi.spyOn(mediaMime, "detectMime").mockResolvedValue(mimeType);
      const read = vi.spyOn(workspaceFs, "readWorkspaceFile");
      const emptyFrame = {
        type: "res",
        id: "",
        ok: true,
        payload: {
          sessionKey: requestParams.sessionKey,
          file: {
            path: requestParams.path,
            name: requestParams.path,
            size: MAX_TERMINAL_UPLOAD_BYTES,
            mimeType,
            contentBase64: "",
          },
        },
      };
      const availableIdBytes =
        MAX_PAYLOAD_BYTES -
        MAX_TERMINAL_UPLOAD_BASE64_LENGTH -
        Buffer.byteLength(JSON.stringify(emptyFrame), "utf8");
      const tokenBytes = Buffer.byteLength(JSON.stringify(token), "utf8") - 2;
      const id =
        token.repeat(Math.floor(availableIdBytes / tokenBytes)) +
        "i".repeat(availableIdBytes % tokenBytes);

      const rejected = await invokeFrame(`${id}i`, requestParams);
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Shorten request" },
      });
      expect(Buffer.byteLength(JSON.stringify(rejected), "utf8")).toBeLessThan(MAX_PAYLOAD_BYTES);
      expect(read).not.toHaveBeenCalled();
      expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();

      const accepted = await invokeFrame(id, requestParams);
      expect(accepted.ok).toBe(true);
      expect((accepted.payload as SessionsFilesDownloadResult).file.size).toBe(
        MAX_TERMINAL_UPLOAD_BYTES,
      );
      expect(Buffer.byteLength(JSON.stringify(accepted), "utf8")).toBe(MAX_PAYLOAD_BYTES);
      expect(read).toHaveBeenCalledOnce();
      expectOkPayload(await invoke("sessions.files.download", params));
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it("fits rejection of a maximum-size inbound ID and leaves admission available", async () => {
    const requestParams = { sessionKey: "a", path: "a" };
    const request = {
      type: "req",
      id: "",
      method: "sessions.files.download",
      params: requestParams,
    };
    request.id = "i".repeat(MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(request), "utf8"));
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBe(MAX_PAYLOAD_BYTES);
    const read = vi.spyOn(workspaceFs, "readWorkspaceFile");
    const rejected = await invokeFrame(request.id, requestParams);
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Shorten request" },
    });
    expect(Buffer.byteLength(JSON.stringify(rejected), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
    expect(read).not.toHaveBeenCalled();
    expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expectOkPayload(await invoke("sessions.files.download", params));
    expect(read).toHaveBeenCalledOnce();
  });

  it("bounds MIME output to the size reserved before reading", async () => {
    vi.spyOn(mediaMime, "detectMime").mockResolvedValue("x".repeat(257));
    const result = expectOkPayload(
      await invoke("sessions.files.download", params),
    ) as SessionsFilesDownloadResult;
    expect(result.file.mimeType).toBe("application/octet-stream");
    expect(Buffer.from(result.file.contentBase64, "base64")).toEqual(bytes);
  });

  it("rejects impossible echoed error envelopes in manual adapters without reading or admission", async () => {
    const request = {
      type: "req" as const,
      id: "",
      method: "sessions.files.download",
      params: { sessionKey: "", path: "a" },
    };
    request.id = "i".repeat(MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(request), "utf8"));
    const respond: RespondFn = vi.fn();
    respond.withCompletion = vi.fn(async () => {});
    const read = vi.spyOn(workspaceFs, "readWorkspaceFile");
    await expect(invokeWithResponse(respond, undefined, request)).rejects.toThrow(
      "Workspace download request exceeds the response envelope budget",
    );
    expect(respond).not.toHaveBeenCalled();
    expect(respond.withCompletion).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expectOkPayload(await invoke("sessions.files.download", params));
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects 16 MiB plus one byte with the download-specific bound", async () => {
    fs.writeFileSync(
      path.join(workspace, params.path),
      Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES + 1),
    );
    const error = expectError(await invoke("sessions.files.download", params));
    expect(error.details).toEqual({
      type: "session_file_too_large",
      path: params.path,
      maxDownloadBytes: MAX_TERMINAL_UPLOAD_BYTES,
    });
  });

  it.each([
    "../private.bin",
    "/file.bin",
    "./file.bin",
    "a/../file.bin",
    "a//file.bin",
    "a\\file.bin",
    "C:/file.bin",
    "file.bin\0",
  ])("rejects a noncanonical relative path %j", async (filePath) => {
    expect(
      expectError(await invoke("sessions.files.download", { ...params, path: filePath })).details
        .type,
    ).toBe("session_file_unsafe");
  });

  it("uses the workspace root instead of a spawned CWD fallback", async () => {
    const cwd = path.join(workspace, "nested");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, params.path), "different nested file");
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      ...loaded,
      entry: { ...loaded.entry, spawnedWorkspaceDir: workspace, spawnedCwd: cwd },
    });
    const result = expectOkPayload(
      await invoke("sessions.files.download", params),
    ) as SessionsFilesDownloadResult;
    expect(Buffer.from(result.file.contentBase64, "base64")).toEqual(bytes);
  });

  it.each(["missing", "directory", "symlink", "hardlink"])("refuses a %s target", async (kind) => {
    const target = path.join(workspace, "target");
    if (kind === "directory") {
      fs.mkdirSync(target);
    }
    if (kind === "symlink") {
      fs.symlinkSync(path.join(outside, "private.bin"), target);
    }
    if (kind === "hardlink") {
      fs.linkSync(path.join(outside, "private.bin"), target);
    }
    expect(
      expectError(await invoke("sessions.files.download", { ...params, path: "target" })).details
        .type,
    ).toBe("session_file_not_found");
  });

  it.runIf(process.platform !== "win32")(
    "refuses a special socket file without blocking",
    async () => {
      const socket = createServer();
      await new Promise<void>((resolve) => {
        socket.listen(path.join(workspace, "socket"), resolve);
      });
      try {
        expect(
          expectError(await invoke("sessions.files.download", { ...params, path: "socket" }))
            .details.type,
        ).toBe("session_file_not_found");
      } finally {
        await new Promise<void>((resolve) => {
          socket.close(() => resolve());
        });
      }
    },
  );

  it.each(["missing-session", "node", "wrong-agent", "worker"])(
    "refuses %s workspace authority",
    async (kind) => {
      if (kind === "missing-session") {
        mocks.loadSessionEntryReadOnly.mockReturnValue({
          cfg: {},
          canonicalKey: params.sessionKey,
        });
      }
      if (kind === "node") {
        mocks.loadSessionEntryReadOnly.mockReturnValue({
          ...loaded,
          entry: { ...loaded.entry, execNode: "synthetic-node" },
        });
      }
      const context =
        kind === "worker"
          ? {
              workerSessionPlacementService: {
                getMany: () => new Map([["download-session", requestedPlacement()]]),
              },
            }
          : {};
      const request = kind === "wrong-agent" ? { ...params, agentId: "other" } : params;
      expect(
        expectError(await invoke("sessions.files.download", request, context)).details.type,
      ).toBe("session_file_download_unavailable");
    },
  );

  it.each(["root", "session", "node", "placement"])(
    "refuses %s reassignment while reading",
    async (kind) => {
      const placements = new Map<string, WorkerSessionPlacementRecord>();
      const read = workspaceFs.readWorkspaceFile;
      vi.spyOn(workspaceFs, "readWorkspaceFile").mockImplementation(async (...args) => {
        const result = await read(...args);
        if (kind === "root") {
          loaded.entry.spawnedCwd = outside;
        }
        if (kind === "session") {
          loaded.entry.sessionId = "replacement-session";
        }
        if (kind === "node") {
          mocks.loadSessionEntryReadOnly.mockReturnValue({
            ...loaded,
            entry: { ...loaded.entry, execNode: "synthetic-node" },
          });
        }
        if (kind === "placement") {
          placements.set("download-session", requestedPlacement());
        }
        return result;
      });
      const context = { workerSessionPlacementService: { getMany: () => placements } };
      expect(
        expectError(await invoke("sessions.files.download", params, context)).details.type,
      ).toBe("session_file_download_unavailable");
    },
  );

  it("admits one maximum-size file until actual response completion, before reading another", async () => {
    fs.writeFileSync(path.join(workspace, params.path), Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES));
    const read = vi.spyOn(workspaceFs, "readWorkspaceFile");
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const respond: RespondFn = vi.fn();
    respond.withCompletion = vi.fn(() => completion);
    let finished = false;
    const first = Promise.resolve(invokeWithResponse(respond)).then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => expect(respond.withCompletion).toHaveBeenCalledOnce());
      const sent = vi.mocked(respond.withCompletion).mock
        .calls[0]?.[1] as SessionsFilesDownloadResult;
      expect(sent.file.size).toBe(MAX_TERMINAL_UPLOAD_BYTES);
      expect(finished).toBe(false);
      expect(expectError(await invoke("sessions.files.download", params))).toMatchObject({
        code: "UNAVAILABLE",
        details: { type: "session_file_download_busy" },
        retryable: true,
      });
      expect(read).toHaveBeenCalledOnce();
    } finally {
      complete();
      await first;
    }
    fs.writeFileSync(path.join(workspace, params.path), bytes);
    expectOkPayload(await invoke("sessions.files.download", params));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refuses responders without a known completion boundary before reading or taking a slot", async () => {
    const read = vi.spyOn(workspaceFs, "readWorkspaceFile");
    const respond: RespondFn = vi.fn();
    await invokeWithResponse(respond);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: { type: "session_file_download_unavailable" },
      }),
    );
    expect(read).not.toHaveBeenCalled();
    expectOkPayload(await invoke("sessions.files.download", params));
  });

  it("retains admission through a rejected-file response, then releases it on completion", async () => {
    fs.writeFileSync(
      path.join(workspace, params.path),
      Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES + 1),
    );
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const respond: RespondFn = vi.fn();
    respond.withCompletion = vi.fn(() => completion);
    const first = Promise.resolve(invokeWithResponse(respond));
    try {
      await vi.waitFor(() => expect(respond.withCompletion).toHaveBeenCalledOnce());
      expect(vi.mocked(respond.withCompletion).mock.calls[0]?.[2]?.details).toMatchObject({
        type: "session_file_too_large",
        maxDownloadBytes: MAX_TERMINAL_UPLOAD_BYTES,
      });
      expect(expectError(await invoke("sessions.files.download", params)).details.type).toBe(
        "session_file_download_busy",
      );
    } finally {
      complete();
      await first;
    }
    fs.writeFileSync(path.join(workspace, params.path), bytes);
    expectOkPayload(await invoke("sessions.files.download", params));
  });

  it("keeps admission until an in-flight read settles after its caller has closed", async () => {
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const read = workspaceFs.readWorkspaceFile;
    const readSpy = vi
      .spyOn(workspaceFs, "readWorkspaceFile")
      .mockImplementationOnce(async (...args) => {
        await reading;
        return await read(...args);
      });
    let closed = false;
    const respond: RespondFn = vi.fn();
    // A closed known transport reports terminal completion as soon as sending is attempted.
    respond.withCompletion = vi.fn(async () => {
      expect(closed).toBe(true);
    });
    const first = Promise.resolve(invokeWithResponse(respond));
    try {
      await vi.waitFor(() => expect(readSpy).toHaveBeenCalledOnce());
      closed = true;
      expect(expectError(await invoke("sessions.files.download", params)).details.type).toBe(
        "session_file_download_busy",
      );
      expect(respond.withCompletion).not.toHaveBeenCalled();
      expect(readSpy).toHaveBeenCalledOnce();
    } finally {
      closed = true;
      releaseRead();
      await first;
    }
    expectOkPayload(await invoke("sessions.files.download", params));
  });

  it.each(["read", "mime", "send", "authorization"])(
    "releases admission after %s failure",
    async (failure) => {
      const failureError = new Error("synthetic failure");
      const respond: RespondFn = vi.fn();
      respond.withCompletion = vi.fn(async () => {});
      if (failure === "read") {
        vi.spyOn(workspaceFs, "readWorkspaceFile").mockRejectedValueOnce(failureError);
      }
      if (failure === "mime") {
        vi.spyOn(mediaMime, "detectMime").mockRejectedValueOnce(failureError);
      }
      if (failure === "send") {
        vi.mocked(respond.withCompletion).mockRejectedValueOnce(failureError);
      }
      const authorization = {
        assertCurrent: () => {
          if (failure === "authorization") {
            throw failureError;
          }
        },
        assertTargetCurrent: vi.fn(),
      };
      await expect(invokeWithResponse(respond, authorization)).rejects.toThrow("synthetic failure");
      if (failure === "authorization") {
        expect(respond.withCompletion).not.toHaveBeenCalled();
      }
      expectOkPayload(await invoke("sessions.files.download", params));
    },
  );
});
