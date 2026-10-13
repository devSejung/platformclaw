import { describe, expect, it, vi } from "vitest";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";
import type { SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

const file = { path: "reports", name: "sample.bin", contentBase64: "AP8B" };

describe("Basic workspace browser uploads", () => {
  it("binds member uploads to their personal session and projects only the saved relative path", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce({
      sessionKey,
      path: "reports/sample.bin",
      size: 3,
      root: "/private/workspace",
    });
    await expect(
      proxy.request(token, "sessions.files.upload", { sessionKey, ...file }),
    ).resolves.toEqual({
      sessionKey,
      path: "reports/sample.bin",
      size: 3,
    });
    expect(request).toHaveBeenCalledWith("sessions.files.upload", {
      sessionKey,
      ...file,
      agentId: binding.agentId,
    });
    for (const params of [
      { sessionKey: "agent:other:main", ...file },
      { sessionKey, ...file, agentId: "other" },
      { sessionKey, ...file, overwrite: true },
      { sessionKey, ...file, root: "/arbitrary" },
    ]) {
      await expect(proxy.request(token, "sessions.files.upload", params)).rejects.toThrow();
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hides upload and rejects stale Basic-workspace controls after switching to a VM", async () => {
    const { binding, proxy, request, store, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request.mockResolvedValue({
      sessionKey,
      uploadAllowed: true,
      files: [],
      browser: { path: "", entries: [] },
    });
    await expect(
      proxy.request(token, "sessions.files.list", { sessionKey }),
    ).resolves.toMatchObject({ uploadAllowed: true });
    vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 2,
      updatedAt: NOW,
    });
    await expect(
      proxy.request(token, "sessions.files.list", { sessionKey }),
    ).resolves.toMatchObject({ uploadAllowed: false });
    await expect(
      proxy.request(token, "sessions.files.upload", { sessionKey, ...file }),
    ).rejects.toMatchObject({
      code: "method-not-allowed",
      requestDisposition: "rejected-before-dispatch",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.files.list",
      "sessions.files.list",
    ]);
  });

  it.each([
    { sessionKey: "agent:other:main", path: "reports/sample.bin", size: 3 },
    { path: "/private/sample.bin", size: 3 },
    { path: "reports/other.bin", size: 3 },
    { path: "reports/sample.bin", size: -1 },
    { path: "reports/sample.bin", size: 2 },
    { path: "reports/sample.bin", size: 16 * 1024 * 1024 + 1 },
  ])("rejects unrelated or malformed upstream upload results: %j", async (result) => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request.mockResolvedValue({ sessionKey, ...result });
    await expect(
      proxy.request(token, "sessions.files.upload", { sessionKey, ...file }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });

  it("rechecks the active execution profile immediately before dispatch", async () => {
    const { binding, proxy, request, store, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    vi.spyOn(store, "getPersonalExecutionProfile")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        agentBindingId: binding.id,
        activeTarget: "assigned_vm",
        activeAllocationId: "allocation-1",
        targetRevision: 2,
        updatedAt: NOW,
      });
    await expect(
      proxy.request(token, "sessions.files.upload", { sessionKey, ...file }),
    ).rejects.toMatchObject({
      code: "method-not-allowed",
      requestDisposition: "rejected-before-dispatch",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps Space viewers and peer owners outside a personal conversation's file-write boundary", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await f.proxy.request<SpaceConversation>(
      f.alice.token,
      "platformclaw.spaces.conversation.create",
      {
        spaceId: f.space.id,
        pageId: f.page.id,
        title: "Synthetic upload test",
        requestId: "upload-test",
      },
    );
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "viewer", 2);
    const sessionKey = conversation.sessionKey;
    f.request.mockResolvedValue({
      sessionKey,
      uploadAllowed: true,
      files: [],
      browser: { path: "", entries: [] },
    });
    await expect(
      f.proxy.request(f.alice.token, "sessions.files.list", { sessionKey }),
    ).resolves.toMatchObject({ uploadAllowed: false });
    const before = f.request.mock.calls.length;
    for (const token of [f.alice.token, f.bob.token, f.carol.token]) {
      await expect(
        f.proxy.request(token, "sessions.files.upload", { sessionKey, ...file }),
      ).rejects.toThrow();
    }
    expect(f.request).toHaveBeenCalledTimes(before);
  });
});
