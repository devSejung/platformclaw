import { describe, expect, it } from "vitest";
import { projectBrowserCronEvent } from "./browser-gateway-cron-policy.js";
import {
  safeCronJob,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy cron", () => {
  it("projects owned cron invalidations without raw run output", () => {
    const agentId = "first-user";
    const job = safeCronJob(agentId);
    const sessionKeyBelongsToAgent = (sessionKey: string) =>
      sessionKey.startsWith(`agent:${agentId}:`);

    expect(
      projectBrowserCronEvent({
        payload: {
          action: "finished",
          jobId: job.id,
          job,
          summary: "private model output",
          error: "private stderr",
          delivery: { intended: { channel: "private" } },
        },
        agentId,
        sessionKeyBelongsToAgent,
      }),
    ).toEqual({ action: "finished", jobId: job.id });
    expect(
      projectBrowserCronEvent({
        payload: { action: "finished", jobId: job.id, job: { ...job, agentId: "other" } },
        agentId,
        sessionKeyBelongsToAgent,
      }),
    ).toBeNull();
    expect(
      projectBrowserCronEvent({
        payload: { action: "removed", jobId: job.id },
        agentId,
        sessionKeyBelongsToAgent,
      }),
    ).toBeNull();
  });

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

  it("returns an empty run-history page when the owned registry has no jobs", async () => {
    const { proxy, request, token } = await setup();
    request.mockResolvedValueOnce({ jobs: [], total: 0, hasMore: false });

    await expect(proxy.request(token, "cron.runs", { scope: "all", limit: 25 })).resolves.toEqual({
      entries: [],
      total: 0,
      limit: 25,
      offset: 0,
      nextOffset: null,
      hasMore: false,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "cron.list",
      expect.objectContaining({ includeDisabled: true, limit: 200, offset: 0 }),
    );
  });

  it("projects owned run history and strips definition-sensitive output", async () => {
    const { binding, proxy, request, token } = await setup();
    const job = safeCronJob(binding.agentId, { name: "Owned summary" });
    request.mockResolvedValueOnce({ jobs: [job], total: 1, hasMore: false }).mockResolvedValueOnce({
      entries: [
        {
          ts: 1_000,
          jobId: job.id,
          action: "finished",
          status: "error",
          error: "privileged stderr",
          summary: "privileged output",
          deliveryError: "private route",
          sessionKey: `agent:${binding.agentId}:cron:${job.id}`,
          runAtMs: 900,
          durationMs: 100,
        },
      ],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    });

    await expect(proxy.request(token, "cron.runs", { limit: 50 })).resolves.toEqual({
      entries: [
        {
          ts: 1_000,
          jobId: job.id,
          action: "finished",
          status: "error",
          sessionKey: `agent:${binding.agentId}:cron:${job.id}`,
          runAtMs: 900,
          durationMs: 100,
          jobName: "Owned summary",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      nextOffset: null,
      hasMore: false,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "cron.runs",
      expect.objectContaining({
        agentId: binding.agentId,
        scope: "job",
        id: job.id,
        limit: 50,
        offset: 0,
      }),
    );
  });

  it("allows bounded delivery changes and strips privileged delivery settings", async () => {
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
      patch: {
        agentId: binding.agentId,
        sessionKey: `agent:${binding.agentId}:main`,
        name: "Renamed",
        delivery: { mode: "none" },
      },
      expectedConfigRevision: "revision-1",
    });
  });

  it("repins partial updates to the owned main session", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce(
        safeCronJob(binding.agentId, {
          sessionKey: `agent:${binding.agentId}:main`,
          delivery: { mode: "announce", channel: "last" },
        }),
      )
      .mockResolvedValueOnce(safeCronJob(binding.agentId, { name: "Renamed" }));

    await proxy.request(token, "cron.update", {
      id: "job-1",
      expectedConfigRevision: "revision-1",
      patch: { name: "Renamed", sessionKey: `agent:${binding.agentId}:other` },
    });

    expect(request).toHaveBeenNthCalledWith(2, "cron.update", {
      id: "job-1",
      expectedConfigRevision: "revision-1",
      patch: {
        agentId: binding.agentId,
        sessionKey: `agent:${binding.agentId}:main`,
        name: "Renamed",
      },
    });
  });

  it("validates delivery against the effective partial-update state", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce(
      safeCronJob(binding.agentId, {
        sessionKey: `agent:${binding.agentId}:main`,
        delivery: { mode: "announce", channel: "last" },
      }),
    );

    await expect(
      proxy.request(token, "cron.update", {
        id: "job-1",
        expectedConfigRevision: "revision-1",
        patch: { sessionTarget: "main" },
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).toHaveBeenCalledTimes(1);

    request.mockReset();
    request
      .mockResolvedValueOnce(safeCronJob(binding.agentId, { delivery: { mode: "none" } }))
      .mockResolvedValueOnce(
        safeCronJob(binding.agentId, { delivery: { mode: "announce", channel: "last" } }),
      );
    await proxy.request(token, "cron.update", {
      id: "job-1",
      expectedConfigRevision: "revision-1",
      patch: { delivery: { mode: "announce" } },
    });
    expect(request).toHaveBeenNthCalledWith(2, "cron.update", {
      id: "job-1",
      expectedConfigRevision: "revision-1",
      patch: {
        agentId: binding.agentId,
        sessionKey: `agent:${binding.agentId}:main`,
        delivery: { mode: "announce", channel: "last" },
      },
    });
  });

  it("creates browser cron jobs for the bound Agent with only owned-session delivery", async () => {
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
      sessionKey: `agent:${binding.agentId}:main`,
      enabled: true,
      sessionTarget: "isolated",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Seoul" },
      payload: { kind: "agentTurn", message: "Summarize my work" },
      delivery: { mode: "announce", channel: "last" },
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
        name: "foreign delivery",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "Summarize" },
        delivery: { mode: "announce", channel: "knox", to: "dm:someone-else" },
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();

    await expect(
      proxy.request(token, "cron.add", {
        name: "shell",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "command", argv: ["whoami"] },
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("limits browser cron models to the configured model catalog", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      models: [{ id: "gpt-5.2", name: "GPT-5.2", provider: "openai" }],
    });

    await expect(
      proxy.request(token, "cron.add", {
        name: "Unconfigured model",
        agentId: binding.agentId,
        sessionTarget: "isolated",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "Summarize", model: "other/custom" },
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });

    request.mockReset();
    request.mockResolvedValueOnce(safeCronJob(binding.agentId));
    request.mockResolvedValueOnce({
      models: [{ id: "gpt-5.2", name: "GPT-5.2", provider: "openai" }],
    });
    request.mockResolvedValueOnce(
      safeCronJob(binding.agentId, {
        payload: { kind: "agentTurn", message: "Summarize", model: "openai/gpt-5.2" },
      }),
    );

    await expect(
      proxy.request(token, "cron.update", {
        id: "job-1",
        expectedConfigRevision: "revision-1",
        patch: {
          payload: { kind: "agentTurn", message: "Summarize", model: "openai/gpt-5.2" },
        },
      }),
    ).resolves.toMatchObject({ id: "job-1" });
    expect(request).toHaveBeenNthCalledWith(1, "cron.get", { id: "job-1" });
    expect(request).toHaveBeenNthCalledWith(2, "models.list", { view: "configured" });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "cron.update",
      expect.objectContaining({
        patch: expect.objectContaining({
          agentId: binding.agentId,
          payload: expect.objectContaining({ model: "openai/gpt-5.2" }),
        }),
      }),
    );

    request.mockReset();
    request
      .mockResolvedValueOnce(
        safeCronJob(binding.agentId, {
          payload: { kind: "agentTurn", message: "Summarize", model: "old/retired" },
        }),
      )
      .mockResolvedValueOnce(
        safeCronJob(binding.agentId, {
          name: "Renamed",
          payload: { kind: "agentTurn", message: "Summarize", model: "old/retired" },
        }),
      );
    await proxy.request(token, "cron.update", {
      id: "job-1",
      expectedConfigRevision: "revision-1",
      patch: {
        name: "Renamed",
        payload: { kind: "agentTurn", message: "Summarize", model: "old/retired" },
      },
    });
    expect(request).not.toHaveBeenCalledWith("models.list", expect.anything());
    expect(request).toHaveBeenNthCalledWith(
      2,
      "cron.update",
      expect.objectContaining({
        patch: expect.objectContaining({
          name: "Renamed",
          payload: expect.objectContaining({ model: "old/retired" }),
        }),
      }),
    );
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
        expectedProcessInstanceId: "process-1",
      }),
    ).resolves.toMatchObject({ ok: true, ran: true });
    expect(request).toHaveBeenNthCalledWith(2, "cron.run", {
      id: "job-1",
      mode: "force",
      expectedConfigRevision: "revision-1",
      expectedProcessInstanceId: "process-1",
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
