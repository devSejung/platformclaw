import { describe, expect, it } from "vitest";
import {
  safeCronJob,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy cron", () => {
  it("scopes cron listing and status to the browser Agent", async () => {
    const { binding, proxy, request, token } = await setup();
    const job = safeCronJob(binding.agentId, {
      enabled: true,
      state: { nextRunAtMs: 9_000 },
    });
    request.mockResolvedValueOnce({
      jobs: [job],
      total: 1,
      limit: 50,
      offset: 0,
      nextOffset: null,
      hasMore: false,
    });

    await expect(
      proxy.request(token, "cron.list", {
        includeDisabled: true,
        includeDeliveryPreviews: false,
      }),
    ).resolves.toEqual({
      jobs: [job],
      total: 1,
      limit: 50,
      offset: 0,
      nextOffset: null,
      hasMore: false,
    });
    expect(request).toHaveBeenCalledWith("cron.list", {
      agentId: binding.agentId,
      includeDisabled: true,
      includeDeliveryPreviews: false,
      scheduleKinds: ["at", "every", "cron"],
      payloadKinds: ["agentTurn", "systemEvent"],
      sessionTargets: ["main", "isolated"],
      sessionAgentId: binding.agentId,
      ownerAgentId: binding.agentId,
      ownerSessionAgentId: binding.agentId,
      requireOwnerAccountId: true,
    });

    request.mockClear();
    request
      .mockResolvedValueOnce({ enabled: true, jobs: 99, nextWakeAtMs: 1234 })
      .mockResolvedValueOnce({ jobs: [job], total: 1, hasMore: false })
      .mockResolvedValueOnce({ jobs: [job], total: 1, hasMore: false });
    await expect(proxy.request(token, "cron.status", {})).resolves.toEqual({
      enabled: true,
      jobs: 1,
      nextWakeAtMs: 9_000,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "cron.list",
      expect.objectContaining({ includeDeliveryPreviews: false }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "cron.list",
      expect.objectContaining({ includeDeliveryPreviews: false }),
    );
  });

  it("rejects browser requests that ask for cron delivery previews", async () => {
    const { proxy, request, token } = await setup();

    await expect(
      proxy.request(token, "cron.list", { includeDeliveryPreviews: true }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not expose cron run history without immutable execution provenance", async () => {
    const { proxy, request, token } = await setup();

    await expect(proxy.request(token, "cron.runs", { scope: "all", limit: 25 })).resolves.toEqual({
      entries: [],
      total: 0,
      limit: 25,
      offset: 0,
      nextOffset: null,
      hasMore: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats cron history without a job selector as all-scope", async () => {
    const { proxy, request, token } = await setup();

    await expect(proxy.request(token, "cron.runs", { limit: 50 })).resolves.toMatchObject({
      entries: [],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves conversational delivery settings on browser cron updates", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce(safeCronJob(binding.agentId))
      .mockResolvedValueOnce(safeCronJob(binding.agentId, { name: "Renamed" }));

    await proxy.request(token, "cron.update", {
      id: "job-1",
      expectedConfigRevision: "revision-1",
      patch: {
        agentId: binding.agentId,
        name: "Renamed",
        delivery: { mode: "none" },
        failureAlert: false,
      },
    });
    expect(request).toHaveBeenNthCalledWith(1, "cron.get", { id: "job-1" });
    expect(request).toHaveBeenNthCalledWith(2, "cron.update", {
      id: "job-1",
      patch: { agentId: binding.agentId, name: "Renamed" },
      expectedConfigRevision: "revision-1",
    });
  });

  it("creates browser cron jobs for the bound Agent without shell or outbound authority", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      created: true,
      job: safeCronJob(binding.agentId),
    });

    await expect(
      proxy.request(token, "cron.add", {
        name: "Daily summary",
        agentId: binding.agentId,
        enabled: true,
        sessionTarget: "isolated",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Seoul" },
        payload: { kind: "agentTurn", message: "Summarize my work" },
        delivery: { mode: "announce" },
      }),
    ).resolves.toMatchObject({ created: true });
    expect(request).toHaveBeenCalledWith("cron.add", {
      name: "Daily summary",
      agentId: binding.agentId,
      enabled: true,
      sessionTarget: "isolated",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Seoul" },
      payload: { kind: "agentTurn", message: "Summarize my work" },
      delivery: { mode: "none" },
      failureAlert: false,
      owner: {
        agentId: binding.agentId,
        sessionKey: `agent:${binding.agentId}:main`,
        accountId: "first.user",
      },
    });

    request.mockClear();
    await expect(
      proxy.request(token, "cron.add", {
        name: "shell",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "command", argv: ["whoami"] },
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("preflights cron mutations and denies jobs owned by another Agent", async () => {
    const { proxy, request, token } = await setup();
    request.mockResolvedValueOnce({ id: "job-other", agentId: "other" });

    await expect(
      proxy.request(token, "cron.run", { id: "job-other", mode: "force" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("cron.get", { id: "job-other" });
  });

  it("pins browser cron mutations to the preflighted definition", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce(safeCronJob(binding.agentId))
      .mockResolvedValueOnce({ ok: true, ran: true });

    await expect(
      proxy.request(token, "cron.run", {
        id: "job-1",
        mode: "force",
        expectedConfigRevision: "revision-1",
      }),
    ).resolves.toMatchObject({ ok: true, ran: true });
    expect(request).toHaveBeenNthCalledWith(2, "cron.run", {
      id: "job-1",
      mode: "force",
      expectedConfigRevision: "revision-1",
    });
  });

  it("rejects cron mutations when the browser-loaded revision is stale", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce(safeCronJob(binding.agentId, { configRevision: "revision-2" }));

    await expect(
      proxy.request(token, "cron.run", {
        id: "job-1",
        mode: "force",
        expectedConfigRevision: "revision-1",
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hides and blocks host-backed cron jobs even when the Agent id matches", async () => {
    const { binding, proxy, request, token } = await setup();
    const privilegedJob = {
      id: "job-host",
      agentId: binding.agentId,
      schedule: { kind: "on-exit", processKey: "gateway" },
      payload: { kind: "command", argv: ["printenv"] },
    };
    request.mockResolvedValueOnce({ jobs: [privilegedJob], total: 1, hasMore: false });
    await expect(proxy.request(token, "cron.list", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });

    request.mockReset();
    request.mockResolvedValueOnce(privilegedJob);
    await expect(
      proxy.request(token, "cron.run", { id: "job-host", mode: "force" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hides and blocks same-Agent cron jobs bound to a foreign session", async () => {
    const { binding, proxy, request, token } = await setup();
    const foreignSessionJob = safeCronJob(binding.agentId, {
      sessionKey: "agent:other:main",
    });
    request.mockResolvedValueOnce({ jobs: [foreignSessionJob], total: 1, hasMore: false });
    await expect(proxy.request(token, "cron.list", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });

    request.mockReset();
    request.mockResolvedValueOnce(foreignSessionJob);
    await expect(
      proxy.request(token, "cron.run", { id: "job-1", mode: "force" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hides legacy outbound jobs without authenticated owner provenance", async () => {
    const { binding, proxy, request, token } = await setup();
    const legacyOutbound = safeCronJob(binding.agentId, {
      owner: undefined,
      delivery: { mode: "webhook", to: "https://operator.invalid/hook" },
    });
    request.mockResolvedValueOnce({ jobs: [legacyOutbound], total: 1, hasMore: false });

    await expect(proxy.request(token, "cron.list", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });

    request.mockReset();
    request.mockResolvedValueOnce(legacyOutbound);
    await expect(
      proxy.request(token, "cron.run", {
        id: "job-1",
        mode: "force",
        expectedConfigRevision: "revision-1",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
