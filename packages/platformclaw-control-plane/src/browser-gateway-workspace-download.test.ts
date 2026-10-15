import { describe, expect, it, vi } from "vitest";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";
import type { SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

const file = {
  path: "reports/합성 파일.bin",
  name: "합성 파일.bin",
  size: 3,
  mimeType: "application/octet-stream",
  contentBase64: "AP8B",
};

describe("Basic workspace browser downloads", () => {
  it.each(["platform_server", "assigned_vm"] as const)(
    "projects download availability from the %s target independently of upload permission",
    async (activeTarget) => {
      const { binding, proxy, request, store, token } = await setup();
      const sessionKey = `agent:${binding.agentId}:main`;
      vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
        agentBindingId: binding.id,
        activeTarget,
        targetRevision: 2,
        updatedAt: NOW,
      });
      request.mockResolvedValue({
        sessionKey,
        uploadAllowed: false,
        // Upstream data cannot grant or withhold the BFF-owned target capability.
        downloadAllowed: activeTarget === "assigned_vm",
        files: [],
        browser: { path: "", entries: [] },
      });
      await expect(
        proxy.request(token, "sessions.files.list", { sessionKey }),
      ).resolves.toMatchObject({
        uploadAllowed: false,
        downloadAllowed: activeTarget === "platform_server",
      });
    },
  );

  it("projects a target switch that completes while the Gateway listing is pending", async () => {
    const { binding, proxy, request, store, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const readProfile = vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue(null);
    let finishList!: (value: unknown) => void;
    request.mockReturnValue(
      new Promise((resolve) => {
        finishList = resolve;
      }),
    );
    const operation = proxy.request(token, "sessions.files.list", { sessionKey });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    readProfile.mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 2,
      updatedAt: NOW,
    });
    finishList({ sessionKey, uploadAllowed: true, files: [] });
    await expect(operation).resolves.toMatchObject({
      uploadAllowed: false,
      downloadAllowed: false,
    });
  });

  it("binds member reads to their personal session and projects only exact download fields", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request.mockResolvedValue({
      sessionKey,
      root: "/private/workspace",
      file: { ...file, absolutePath: "/private/workspace/reports/sample.bin" },
    });
    await expect(
      proxy.request(token, "sessions.files.download", { sessionKey, path: file.path }),
    ).resolves.toEqual({ sessionKey, file });
    expect(request).toHaveBeenCalledWith("sessions.files.download", {
      sessionKey,
      path: file.path,
      agentId: binding.agentId,
    });
    for (const params of [
      { sessionKey: "agent:other:main", path: file.path },
      { sessionKey, path: file.path, agentId: "other" },
      { sessionKey, path: file.path, root: "/arbitrary" },
      { sessionKey, path: file.path, maxBytes: 1_000_000_000 },
      { sessionKey, path: file.path, offset: 0 },
    ]) {
      await expect(proxy.request(token, "sessions.files.download", params)).rejects.toThrow();
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves empty bytes and accepts a safe sanitized filename", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const empty = { ...file, path: "reports/CON", name: "CON_", size: 0, contentBase64: "" };
    request.mockResolvedValue({ sessionKey, file: empty });
    await expect(
      proxy.request(token, "sessions.files.download", { sessionKey, path: empty.path }),
    ).resolves.toEqual({ sessionKey, file: empty });
  });

  it.each([
    { path: "reports/other.bin" },
    { path: "/private/sample.bin" },
    { name: "../sample.bin" },
    { name: "sample\u0000.bin" },
    { name: "" },
    { size: -1 },
    { size: 2 },
    { size: 16 * 1024 * 1024 + 1 },
    { contentBase64: "AP8B\n" },
    { contentBase64: "AB==", size: 1 },
    { contentBase64: "AP8", size: 2 },
    { mimeType: "" },
  ])("rejects malformed or mismatched upstream download fields: %j", async (change) => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request.mockResolvedValue({ sessionKey, file: { ...file, ...change } });
    await expect(
      proxy.request(token, "sessions.files.download", { sessionKey, path: file.path }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });

  it("rejects a different upstream session even inside the same agent", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    for (const other of ["agent:other:main", `agent:${binding.agentId}:other`]) {
      request.mockResolvedValue({ sessionKey: other, file });
      await expect(
        proxy.request(token, "sessions.files.download", { sessionKey, path: file.path }),
      ).rejects.toMatchObject({ code: "upstream-result-denied" });
    }
  });

  it.each([false, true])(
    "rejects assigned VM before dispatch, including a target switch: %s",
    async (switching) => {
      const { binding, proxy, request, store, token } = await setup();
      const profile = {
        agentBindingId: binding.id,
        activeTarget: "assigned_vm" as const,
        activeAllocationId: "allocation-1",
        targetRevision: 2,
        updatedAt: NOW,
      };
      const readProfile = vi.spyOn(store, "getPersonalExecutionProfile");
      if (switching) {
        readProfile.mockResolvedValueOnce(null);
      }
      readProfile.mockResolvedValue(profile);
      await expect(
        proxy.request(token, "sessions.files.download", {
          sessionKey: `agent:${binding.agentId}:main`,
          path: file.path,
        }),
      ).rejects.toMatchObject({
        code: "method-not-allowed",
        requestDisposition: "rejected-before-dispatch",
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("retains own-viewer reads while denying peer owners and revoked Space membership", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await f.proxy.request<SpaceConversation>(
      f.alice.token,
      "platformclaw.spaces.conversation.create",
      {
        spaceId: f.space.id,
        pageId: f.page.id,
        title: "Synthetic download test",
        requestId: "download-test",
      },
    );
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "viewer", 2);
    const sessionKey = conversation.sessionKey;
    const params = { sessionKey, path: file.path };
    f.request.mockResolvedValue({ sessionKey, uploadAllowed: true, files: [] });
    await expect(
      f.proxy.request(f.alice.token, "sessions.files.list", { sessionKey }),
    ).resolves.toMatchObject({ uploadAllowed: false, downloadAllowed: true });
    f.request.mockResolvedValue({ sessionKey, file });
    await expect(
      f.proxy.request(f.alice.token, "sessions.files.download", params),
    ).resolves.toEqual({ sessionKey, file });
    const before = f.request.mock.calls.length;
    for (const token of [f.bob.token, f.carol.token]) {
      await expect(f.proxy.request(token, "sessions.files.download", params)).rejects.toThrow();
    }
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 3);
    await expect(
      f.proxy.request(f.alice.token, "sessions.files.download", params),
    ).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(before);
  });
});
