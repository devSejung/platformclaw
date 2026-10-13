import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import * as uploadWorkers from "./sessions-files-upload-worker.js";
import {
  isSessionFileUploadAllowed,
  sessionsFilesUploadHandlers,
} from "./sessions-files-upload.js";
import {
  createSessionEntryFixture,
  createSessionFilesHandlerInvoker,
  createWorkspaceFixture,
  expectError,
  expectOkPayload,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntryReadOnly: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));
vi.mock("../session-utils.js", () => ({
  loadSessionEntryReadOnly: hoisted.loadSessionEntryReadOnly,
}));
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

const invoke = createSessionFilesHandlerInvoker(sessionsFilesUploadHandlers);
const sessionKey = "agent:main:main";
const content = Buffer.from([0x00, 0x01, 0xff, 0x0a]);
const upload = {
  sessionKey,
  path: "",
  name: "data.bin",
  contentBase64: content.toString("base64"),
};

describe("session workspace uploads", { timeout: 20_000 }, () => {
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRoot = createWorkspaceFixture("openclaw-workspace-upload-");
    outsideRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "openclaw-upload-outside-"),
    );
    hoisted.loadSessionEntryReadOnly.mockReturnValue(
      createSessionEntryFixture(workspaceRoot, "session-upload"),
    );
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it.each(["", "src", "src/nested"])(
    "creates exact binary bytes in existing folder %j",
    async (folder) => {
      if (folder === "src/nested") {
        fs.mkdirSync(path.join(workspaceRoot, "src", "nested"));
      }
      const result = expectOkPayload(
        await invoke("sessions.files.upload", { ...upload, path: folder }),
      );
      const filePath = folder ? `${folder}/${upload.name}` : upload.name;
      expect(result).toEqual({ sessionKey, path: filePath, size: content.length });
      expect(fs.readFileSync(path.join(workspaceRoot, filePath))).toEqual(content);
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(workspaceRoot, filePath)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("allows an empty file and preserves its selected name", async () => {
    expectOkPayload(
      await invoke("sessions.files.upload", { ...upload, name: "빈 파일.txt", contentBase64: "" }),
    );
    expect(fs.readFileSync(path.join(workspaceRoot, "빈 파일.txt"))).toHaveLength(0);
  });

  it.each(["a".repeat(206), `${"가".repeat(68)}aa`])(
    "accepts a 206-byte leaf name %j",
    async (name) => {
      expect(Buffer.byteLength(name, "utf8")).toBe(206);
      expectOkPayload(await invoke("sessions.files.upload", { ...upload, name }));
      expect(fs.readFileSync(path.join(workspaceRoot, name))).toEqual(content);
    },
  );

  it.each(["a".repeat(207), "가".repeat(69)])(
    "rejects a 207-byte leaf before starting a Worker %j",
    async (name) => {
      const admission = vi.spyOn(uploadWorkers, "acquireSessionFileUploadLease");
      const error = expectError(await invoke("sessions.files.upload", { ...upload, name }));
      expect(error.details).toMatchObject({
        type: "session_file_name_too_long",
        outcome: "not-written",
      });
      expect(error.message).toContain("206 UTF-8 bytes");
      expect(admission).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspaceRoot, name))).toBe(false);
    },
  );

  it("keeps existing directory segment allowance at 255 bytes", async () => {
    const folder = "a".repeat(255);
    fs.mkdirSync(path.join(workspaceRoot, folder));
    expect(await isSessionFileUploadAllowed({ ...upload, path: folder }, {} as never)).toBe(true);
    expectOkPayload(await invoke("sessions.files.upload", { ...upload, path: folder }));
    expect(fs.readFileSync(path.join(workspaceRoot, folder, upload.name))).toEqual(content);
  });

  it("rejects duplicates atomically across simultaneous uploads", async () => {
    const calls = await Promise.all([
      invoke("sessions.files.upload", upload),
      invoke("sessions.files.upload", {
        ...upload,
        contentBase64: Buffer.from("other").toString("base64"),
      }),
    ]);
    expect(
      calls.map((call) => call[0]?.ok).toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    const failed = calls.find((call) => call[0]?.ok === false)!;
    expect(expectError(failed).details).toMatchObject({ type: "session_file_exists" });
    const winner = calls[0]?.[0]?.ok ? content : Buffer.from("other");
    expect(fs.readFileSync(path.join(workspaceRoot, upload.name))).toEqual(winner);
  });

  it.each([
    { name: "../escape.bin" },
    { name: "a/b.bin" },
    { name: "a\\b.bin" },
    { name: "." },
    { name: ".." },
    { name: "C:alternate" },
    { name: "file:stream" },
    { name: "CON.txt" },
    { name: "trailing." },
    { name: "trailing " },
    { name: "nul\0.txt" },
    { name: "\ud800.txt" },
    { path: "../outside" },
    { path: "/absolute" },
    { path: "C:/absolute" },
    { path: "src/../ui" },
    { path: "src\\nested" },
    { path: "src//nested" },
  ])("rejects hostile upload path %j without creating a file", async (change) => {
    const error = expectError(await invoke("sessions.files.upload", { ...upload, ...change }));
    expect(error.details).toMatchObject({ type: "session_file_unsafe" });
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });

  it("does not create missing parent folders", async () => {
    const error = expectError(
      await invoke("sessions.files.upload", { ...upload, path: "missing/nested" }),
    );
    expect(error.details).toMatchObject({ type: "session_file_unsafe" });
    expect(fs.existsSync(path.join(workspaceRoot, "missing"))).toBe(false);
  });

  it("rejects symlinked parent folders without touching the outside root", async () => {
    fs.symlinkSync(
      outsideRoot,
      path.join(workspaceRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const error = expectError(await invoke("sessions.files.upload", { ...upload, path: "linked" }));
    expect(error.details).toMatchObject({ type: "session_file_unsafe" });
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });

  it("rejects a parent symlink even when it points to another workspace folder", async () => {
    fs.symlinkSync(
      path.join(workspaceRoot, "src"),
      path.join(workspaceRoot, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await isSessionFileUploadAllowed({ ...upload, path: "alias" }, {} as never)).toBe(false);
    const error = expectError(await invoke("sessions.files.upload", { ...upload, path: "alias" }));
    expect(error.details).toMatchObject({ type: "session_file_unsafe" });
    expect(fs.existsSync(path.join(workspaceRoot, "src", upload.name))).toBe(false);
  });

  it("preserves existing hardlinked files", async () => {
    const outside = path.join(outsideRoot, "original.bin");
    fs.writeFileSync(outside, "existing bytes");
    fs.linkSync(outside, path.join(workspaceRoot, upload.name));
    expectError(await invoke("sessions.files.upload", upload));
    expect(fs.readFileSync(outside, "utf8")).toBe("existing bytes");
    expect(fs.readFileSync(path.join(workspaceRoot, upload.name), "utf8")).toBe("existing bytes");
  });

  it("refuses an unknown session instead of falling back to the default workspace", async () => {
    hoisted.loadSessionEntryReadOnly.mockReturnValue({ cfg: {}, canonicalKey: sessionKey });
    expect(expectError(await invoke("sessions.files.upload", upload)).details).toMatchObject({
      type: "session_file_not_found",
    });
    expect(hoisted.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
  });

  it.each(["AA=", "AB==", "YQ", "!!!!", "YQ==\n"])(
    "rejects invalid encoding %j",
    async (contentBase64) => {
      const error = expectError(
        await invoke("sessions.files.upload", { ...upload, contentBase64 }),
      );
      expect(error.details).toMatchObject({ type: "session_file_invalid_encoding" });
      expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
    },
  );

  it("rejects a decoded file over the 16 MiB ceiling before allocating its Buffer", async () => {
    const contentBase64 = Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES + 1).toString("base64");
    const error = expectError(await invoke("sessions.files.upload", { ...upload, contentBase64 }));
    expect(error.details).toMatchObject({ type: "session_file_too_large" });
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
  });

  it("rejects an oversized encoded payload before parsing its content or loading the session", async () => {
    const contentBase64 = "A".repeat(MAX_TERMINAL_UPLOAD_BASE64_LENGTH + 4);
    const decode = vi.spyOn(Buffer, "from");
    try {
      const error = expectError(
        await invoke("sessions.files.upload", { ...upload, contentBase64 }),
      );
      expect(error.code).toBe("INVALID_REQUEST");
      expect(decode).not.toHaveBeenCalledWith(contentBase64, "base64");
      expect(hoisted.loadSessionEntryReadOnly).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
    } finally {
      decode.mockRestore();
    }
  });

  it("rejects busy admission before decoding the payload or starting filesystem discovery", async () => {
    vi.spyOn(uploadWorkers, "acquireSessionFileUploadLease").mockReturnValue(undefined);
    const decode = vi.spyOn(Buffer, "from");
    const error = expectError(await invoke("sessions.files.upload", upload));
    expect(error.details).toMatchObject({
      type: "session_file_upload_busy",
      outcome: "not-written",
    });
    expect(decode).not.toHaveBeenCalledWith(upload.contentBase64, "base64");
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
  });

  it("returns the canonical UI outcome-unknown metadata without retrying a dispatched write", async () => {
    const release = vi.fn();
    const run = vi
      .fn()
      .mockRejectedValue(new uploadWorkers.SessionUploadWorkerError("timeout", "unknown"));
    vi.spyOn(uploadWorkers, "acquireSessionFileUploadLease").mockReturnValue({ run, release });
    const error = expectError(await invoke("sessions.files.upload", upload));
    expect(error).toMatchObject({
      retryable: false,
      details: {
        type: "session_file_upload_outcome_unknown",
        outcome: "unknown",
        requestDisposition: "outcome-unknown",
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("never writes an exec-node session into the Gateway host workspace", async () => {
    const fixture = createSessionEntryFixture(workspaceRoot, "session-upload");
    hoisted.loadSessionEntryReadOnly.mockReturnValue({
      ...fixture,
      entry: { ...fixture.entry, execNode: "remote-node" },
    });
    expect(expectError(await invoke("sessions.files.upload", upload)).details).toMatchObject({
      type: "session_file_upload_unavailable",
    });
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
  });

  it.each([
    "requested",
    "provisioning",
    "syncing",
    "starting",
    "active",
    "draining",
    "reconciling",
    "failed",
  ])("rejects cloud placement %s", async (state) => {
    const context = {
      workerSessionPlacementService: { getMany: () => new Map([["session-upload", { state }]]) },
    };
    expect(
      expectError(await invoke("sessions.files.upload", upload, context)).details,
    ).toMatchObject({ type: "session_file_upload_unavailable" });
    expect(await isSessionFileUploadAllowed(upload, context as never)).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
  });

  it("advertises uploads only for a safe existing local folder", async () => {
    expect(await isSessionFileUploadAllowed(upload, {} as never)).toBe(true);
    expect(await isSessionFileUploadAllowed({ ...upload, path: "missing" }, {} as never)).toBe(
      false,
    );
    expect(await isSessionFileUploadAllowed({ ...upload, path: "../" }, {} as never)).toBe(false);
  });

  it.each(["replaced", "moved", "exec-node"])(
    "refuses a session %s during asynchronous folder discovery, including admin service calls",
    async (change) => {
      const original = createSessionEntryFixture(workspaceRoot, "session-upload");
      const current = {
        ...original,
        entry: {
          ...original.entry,
          ...(change === "replaced" ? { sessionId: "replacement-session" } : {}),
          ...(change === "moved" ? { spawnedCwd: outsideRoot } : {}),
          ...(change === "exec-node" ? { execNode: "remote-node" } : {}),
        },
      };
      hoisted.loadSessionEntryReadOnly.mockReturnValueOnce(original).mockReturnValue(current);
      const error = expectError(await invoke("sessions.files.upload", upload));
      expect(error.details).toMatchObject({ type: "session_file_upload_unavailable" });
      expect(hoisted.loadSessionEntryReadOnly).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
      expect(fs.existsSync(path.join(outsideRoot, upload.name))).toBe(false);
    },
  );

  it("refuses cloud placement admitted during asynchronous folder discovery", async () => {
    const getMany = vi
      .fn()
      .mockReturnValueOnce(new Map())
      .mockReturnValue(new Map([["session-upload", { state: "requested" }]]));
    const context = { workerSessionPlacementService: { getMany } };
    const error = expectError(await invoke("sessions.files.upload", upload, context));
    expect(error.details).toMatchObject({ type: "session_file_upload_unavailable" });
    expect(getMany).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
  });

  it("rechecks the authorized session immediately before creating the file", async () => {
    const assertCurrent = vi.fn(() => {
      throw new Error("session replaced");
    });
    const respond = vi.fn();
    await expect(
      sessionsFilesUploadHandlers["sessions.files.upload"]!({
        req: { type: "req", id: "upload", method: "sessions.files.upload", params: upload },
        params: upload,
        client: null,
        isWebchatConnect: () => false,
        context: {} as never,
        respond,
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: vi.fn() },
      }),
    ).rejects.toThrow("session replaced");
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspaceRoot, upload.name))).toBe(false);
  });
});
