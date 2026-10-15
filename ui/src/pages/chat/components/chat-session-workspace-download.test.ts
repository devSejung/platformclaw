import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../../api/gateway.ts";
import { SessionWorkspaceDownloadController } from "./chat-session-workspace-download.ts";

function harness(
  request = vi.fn().mockResolvedValue({
    sessionKey: "agent:main:main",
    file: {
      path: "docs/file.bin",
      name: "file.bin",
      size: 3,
      mimeType: "application/octet-stream",
      contentBase64: "AP8B",
    },
  }),
) {
  const target = {
    client: { request } as unknown as GatewayBrowserClient,
    sessionKey: "agent:main:main",
    agentId: "main",
  };
  const host = { capture: () => target, isCurrent: vi.fn(() => true), requestUpdate: vi.fn() };
  const createObjectURL = vi.fn((_blob: Blob) => "blob:synthetic-download");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const anchors: HTMLAnchorElement[] = [];
  const clicked = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
  return {
    download: new SessionWorkspaceDownloadController(host),
    request,
    host,
    createObjectURL,
    revokeObjectURL,
    clicked,
    anchors,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("workspace download lifecycle", () => {
  it("saves binary bytes with a basename and revokes the temporary object URL", async () => {
    const f = harness();
    await f.download.download("docs/file.bin");
    expect(f.request).toHaveBeenCalledWith("sessions.files.download", {
      sessionKey: "agent:main:main",
      agentId: "main",
      path: "docs/file.bin",
    });
    expect(f.clicked).toHaveBeenCalledOnce();
    expect(f.anchors[0]?.download).toBe("file.bin");
    const blob = f.createObjectURL.mock.calls[0]?.[0] as Blob;
    const reader = new FileReader();
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      reader.addEventListener("load", () => resolve(reader.result as ArrayBuffer), { once: true });
      reader.addEventListener("error", reject, { once: true });
      reader.readAsArrayBuffer(blob);
    });
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0, 255, 1]));
    expect(document.querySelector("a[download]")).toBeNull();
    await vi.waitFor(() =>
      expect(f.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-download"),
    );
    expect(f.download.error).toBeNull();
  });

  it("shows the 16 MiB limit when the Gateway rejects an oversized file", async () => {
    const f = harness(
      vi.fn().mockRejectedValue(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "too large",
          details: { type: "session_file_too_large", maxDownloadBytes: 16 * 1024 * 1024 },
        }),
      ),
    );
    await f.download.download("docs/file.bin");
    expect(f.download.error).toBe(
      "File exceeds the 16 MiB workspace download limit: docs/file.bin",
    );
    expect(f.createObjectURL).not.toHaveBeenCalled();
    expect(f.download.busy).toBe(false);
  });

  it.each(["session", "teardown"])(
    "discards an in-flight response after %s changes",
    async (change) => {
      let resolve!: (result: unknown) => void;
      const pending = new Promise((yes) => {
        resolve = yes;
      });
      const f = harness(vi.fn().mockReturnValue(pending));
      const operation = f.download.download("docs/file.bin");
      await f.download.download("docs/file.bin");
      expect(f.request).toHaveBeenCalledOnce();
      if (change === "session") {
        f.host.isCurrent.mockReturnValue(false);
      } else {
        f.download.dispose();
      }
      resolve({
        sessionKey: "agent:main:main",
        file: {
          path: "docs/file.bin",
          name: "file.bin",
          size: 0,
          mimeType: "application/octet-stream",
          contentBase64: "",
        },
      });
      await operation;
      expect(f.createObjectURL).not.toHaveBeenCalled();
      expect(f.download.busy).toBe(false);
    },
  );
});
