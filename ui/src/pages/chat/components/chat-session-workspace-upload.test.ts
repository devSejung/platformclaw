/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../../api/gateway.ts";
import {
  SessionWorkspaceUploadController,
  renderWorkspaceUploadNotice,
} from "./chat-session-workspace-upload.ts";
import {
  clearSessionWorkspaceTimers,
  createSessionWorkspaceProps,
  toggleSessionWorkspace,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

function file(name: string, bytes: number[] = [0, 255, 1]): File {
  const result = new File([new Uint8Array(bytes)], name);
  Object.defineProperty(result, "arrayBuffer", {
    configurable: true,
    value: async () => new Uint8Array(bytes).buffer,
  });
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function uploadHarness(request = vi.fn().mockResolvedValue({ path: "docs/file.bin", size: 3 })) {
  const target = {
    client: { request } as unknown as GatewayBrowserClient,
    sessionKey: "agent:main:current",
    agentId: "main",
    path: "docs",
  };
  const host = {
    capture: () => target,
    isCurrent: vi.fn(() => true),
    refresh: vi.fn(),
    requestUpdate: vi.fn(),
  };
  return { upload: new SessionWorkspaceUploadController(host), target, host, request };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("workspace upload lifecycle", () => {
  it("uploads exact binary bytes into the captured folder and preserves the completed notice", async () => {
    const { upload, request, host } = uploadHarness();
    upload.uploadFiles([file("binary.bin"), file("empty.txt", [])]);
    await vi.waitFor(() => expect(upload.notice?.state).toBe("complete"));
    expect(request.mock.calls.map(([method, params]) => ({ method, params }))).toEqual([
      {
        method: "sessions.files.upload",
        params: {
          sessionKey: "agent:main:current",
          agentId: "main",
          path: "docs",
          name: "binary.bin",
          contentBase64: "AP8B",
        },
      },
      {
        method: "sessions.files.upload",
        params: {
          sessionKey: "agent:main:current",
          agentId: "main",
          path: "docs",
          name: "empty.txt",
          contentBase64: "",
        },
      },
    ]);
    expect(upload.notice).toMatchObject({
      path: "docs",
      completed: 2,
      names: ["binary.bin", "empty.txt"],
    });
    expect(host.refresh).toHaveBeenCalledOnce();
    const container = document.createElement("div");
    render(renderWorkspaceUploadNotice(upload), container);
    expect(container.textContent).toContain("Uploaded 2 workspace files");
    expect(container.textContent).toContain("binary.bin, empty.txt");
  });

  it("retains successful files and retries only the transient failed remainder", async () => {
    const second = deferred<unknown>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue({});
    const { upload, host } = uploadHarness(request);
    upload.uploadFiles([file("first.bin"), file("second.bin")]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(upload.notice).toMatchObject({ state: "uploading", completed: 1 });
    second.reject(Object.assign(new Error("temporary failure"), { gatewayCode: "UNAVAILABLE" }));
    await vi.waitFor(() => expect(upload.retryable).toBe(true));
    expect(upload.notice).toMatchObject({
      state: "failed",
      completed: 1,
      error: "temporary failure",
    });
    upload.retry();
    await vi.waitFor(() => expect(upload.notice?.state).toBe("complete"));
    expect(request.mock.calls.map(([, params]) => params.name)).toEqual([
      "first.bin",
      "second.bin",
      "second.bin",
    ]);
    expect(host.refresh).toHaveBeenCalledTimes(2);
  });

  it("blocks oversized files before reading and permits a new selection after the error", async () => {
    const { upload, request } = uploadHarness();
    const oversized = file("large.bin");
    const read = vi.spyOn(oversized, "arrayBuffer");
    Object.defineProperty(oversized, "size", { value: 16 * 1024 * 1024 + 1 });
    upload.uploadFiles([oversized]);
    await vi.waitFor(() => expect(upload.notice?.state).toBe("failed"));
    expect(upload.notice?.error).toContain("16 MiB");
    expect(read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    upload.uploadFiles([file("small.bin")]);
    await vi.waitFor(() => expect(upload.notice?.state).toBe("complete"));
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Upload response was lost",
      retryable: true,
      details: { requestDisposition: "outcome-unknown" },
    }),
    Object.assign(new Error("Gateway connection closed"), {
      details: { requestDisposition: "outcome-unknown" },
    }),
  ])(
    "requires confirmation after a sent upload has an unknown outcome: $message",
    async (error) => {
      const request = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(error);
      const { upload, host } = uploadHarness(request);
      upload.uploadFiles([file("first.bin"), file("unconfirmed.bin"), file("remaining.bin")]);
      await vi.waitFor(() => expect(upload.notice?.state).toBe("unconfirmed"));
      expect(upload.notice?.completed).toBe(1);
      expect(upload.retryable).toBe(false);
      expect(host.refresh).toHaveBeenCalledOnce();
      const container = document.createElement("div");
      render(renderWorkspaceUploadNotice(upload), container);
      expect(container.querySelector("[role='alert']")).not.toBeNull();
      expect(container.textContent).toContain("Workspace upload needs confirmation");
      expect(container.textContent).toContain("unconfirmed.bin");
      expect(container.textContent).toContain("Confirmed saved: 1 of 3 files");
      expect(container.textContent).toContain("may already be saved or still processing");
      expect(container.textContent).toContain("Refresh this folder");
      expect(container.querySelector("button")).toBeNull();
      upload.retry();
      expect(request.mock.calls.map(([, params]) => params.name)).toEqual([
        "first.bin",
        "unconfirmed.bin",
      ]);
    },
  );

  it("keeps a rejected-before-dispatch upload retryable", async () => {
    const error = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Upload did not start",
      retryable: true,
      details: { requestDisposition: "rejected-before-dispatch" },
    });
    const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({});
    const { upload } = uploadHarness(request);
    upload.uploadFiles([file("safe-retry.bin")]);
    await vi.waitFor(() => expect(upload.notice?.state).toBe("failed"));
    expect(upload.retryable).toBe(true);
    upload.retry();
    await vi.waitFor(() => expect(upload.notice?.state).toBe("complete"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shows rename guidance for a duplicate without retrying it", async () => {
    const request = vi.fn().mockRejectedValue(
      Object.assign(new Error("exists"), {
        details: { type: "session_file_exists" },
        gatewayCode: "INVALID_REQUEST",
      }),
    );
    const { upload } = uploadHarness(request);
    upload.uploadFiles([file("existing.bin")]);
    await vi.waitFor(() => expect(upload.notice?.state).toBe("failed"));
    expect(upload.notice?.error).toContain("Rename the local file");
    expect(upload.retryable).toBe(false);
    upload.retry();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["stop", "scope", "dispose"])(
    "ignores a late upload response after %s and never sends the next file",
    async (action) => {
      const pending = deferred<unknown>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const { upload, host } = uploadHarness(request);
      upload.uploadFiles([file("first.bin"), file("second.bin")]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const signal = request.mock.calls[0]?.[2]?.signal as AbortSignal;
      if (action === "scope") {
        host.isCurrent.mockReturnValue(false);
        upload.sync();
      } else if (action === "dispose") {
        upload.dispose();
      } else {
        upload.stop();
      }
      expect(signal.aborted).toBe(true);
      pending.resolve({});
      await Promise.resolve();
      expect(request).toHaveBeenCalledOnce();
      expect(upload.notice?.completed ?? 0).toBe(0);
      expect(upload.notice?.state).toBe(action === "dispose" ? undefined : "stopped");
    },
  );

  it("checks scope again after reading a file and resets the file input", async () => {
    const { upload, request, host } = uploadHarness();
    const pending = deferred<ArrayBuffer>();
    const selected = file("same.bin");
    Object.defineProperty(selected, "arrayBuffer", { value: () => pending.promise });
    const input = document.createElement("input");
    Object.defineProperty(input, "files", { value: [selected] });
    input.value = "selected";
    upload.selectFiles({ currentTarget: input } as unknown as Event);
    expect(input.value).toBe("");
    host.isCurrent.mockReturnValue(false);
    pending.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => expect(upload.notice?.state).toBe("stopped"));
    expect(request).not.toHaveBeenCalled();
  });
});

describe("workspace upload access and ownership", () => {
  async function workspace(scopes: string[], capabilities: string[] = [], uploadAllowed = true) {
    const state = {
      client: { request: vi.fn().mockResolvedValue({}) },
      connected: true,
      hello: {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes },
        features: { methods: ["sessions.files.upload"], capabilities },
      },
      sessionKey: "agent:main:current",
      handleOpenSidebar: vi.fn(),
      requestUpdate: vi.fn(),
      sessions: {
        listFiles: vi.fn().mockResolvedValue({
          sessionKey: "agent:main:current",
          root: "/synthetic",
          files: [],
          uploadAllowed,
          browser: { path: "", entries: [] },
        }),
      },
    } as unknown as SessionWorkspaceHost;
    toggleSessionWorkspace(state);
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());
    return state;
  }

  it.each([
    { scopes: ["operator.admin"], capabilities: [], allowed: true },
    { scopes: ["operator.write"], capabilities: [], allowed: false },
    {
      scopes: ["operator.write"],
      capabilities: ["control-ui.server-authorized-methods"],
      allowed: true,
    },
  ])(
    "matches direct Gateway and server-authorized method scope semantics: $allowed",
    async ({ scopes, capabilities, allowed }) => {
      const state = await workspace(scopes, capabilities);
      expect(createSessionWorkspaceProps(state).uploadAllowed).toBe(allowed);
      state.hello!.features!.methods = [];
      expect(createSessionWorkspaceProps(state).uploadAllowed).toBe(false);
    },
  );

  it("requires session upload permission, a loaded folder and no active search", async () => {
    const state = await workspace(["operator.admin"], [], false);
    expect(createSessionWorkspaceProps(state).uploadAllowed).toBe(false);
    state.sessionWorkspaceState!.list!.uploadAllowed = true;
    expect(createSessionWorkspaceProps(state).uploadAllowed).toBe(true);
    createSessionWorkspaceProps(state).onSearch("secret");
    expect(createSessionWorkspaceProps(state).uploadAllowed).toBe(false);
    clearSessionWorkspaceTimers(state);
  });

  it.each(["session", "client", "disconnect", "teardown", "folder"])(
    "stops pending uploads after %s changes",
    async (change) => {
      const state = await workspace(["operator.admin"]);
      const pending = deferred<unknown>();
      const request = vi.fn().mockReturnValue(pending.promise);
      state.client = { request } as unknown as GatewayBrowserClient;
      const upload = createSessionWorkspaceProps(state).upload!;
      upload.uploadFiles([file("first.bin"), file("second.bin")]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      if (change === "session") {
        state.sessionKey = "agent:main:other";
      } else if (change === "client") {
        state.client = {} as GatewayBrowserClient;
      } else if (change === "disconnect") {
        state.connected = false;
      } else if (change === "teardown") {
        clearSessionWorkspaceTimers(state);
      } else {
        state.sessionWorkspaceState!.browserPath = "docs";
      }
      const next = createSessionWorkspaceProps(state).upload;
      if (change === "session" || change === "teardown") {
        expect(next?.notice).toBeNull();
        expect(upload.notice).toBeNull();
      } else {
        expect(upload.notice?.state).toBe("stopped");
      }
      pending.resolve({});
      await Promise.resolve();
      expect(request).toHaveBeenCalledOnce();
      clearSessionWorkspaceTimers(state);
    },
  );
});
