import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy task recovery", () => {
  it.each([
    { name: "empty", taskIds: [] },
    { name: "duplicate", taskIds: ["task-1", "task-1"] },
    { name: "over limit", taskIds: Array.from({ length: 11 }, (_, index) => `task-${index}`) },
  ])("rejects $name task id batches before dispatch", async ({ taskIds }) => {
    const { proxy, request, token } = await setup();

    await expect(proxy.request(token, "tasks.retry", { taskIds })).rejects.toMatchObject({
      code: "invalid-params",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("verifies ownership and projects only requested tasks", async () => {
    const { binding, proxy, request, token } = await setup();
    const ownedTask = {
      id: "task-owned",
      status: "blocked",
      agentId: binding.agentId,
      sessionKey: `agent:${binding.agentId}:main`,
    };
    request.mockResolvedValueOnce({ task: ownedTask }).mockResolvedValueOnce({
      results: [{ taskId: ownedTask.id, ok: true, task: { ...ownedTask, status: "completed" } }],
    });

    await expect(proxy.request(token, "tasks.retry", { taskIds: [ownedTask.id] })).resolves.toEqual(
      {
        results: [{ taskId: ownedTask.id, ok: true, task: { ...ownedTask, status: "completed" } }],
      },
    );
    expect(request).toHaveBeenNthCalledWith(1, "tasks.get", { taskId: ownedTask.id });
    expect(request).toHaveBeenNthCalledWith(2, "tasks.retry", { taskIds: [ownedTask.id] });

    request.mockReset();
    request.mockResolvedValueOnce({ task: ownedTask }).mockResolvedValueOnce({
      results: [{ taskId: "task-other", ok: false, reason: "private state" }],
    });
    await expect(
      proxy.request(token, "tasks.dismiss", { taskIds: [ownedTask.id] }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });

    request.mockReset();
    request.mockResolvedValueOnce({
      task: { ...ownedTask, id: "task-other", agentId: "other" },
    });
    await expect(
      proxy.request(token, "tasks.retry", { taskIds: ["task-other"] }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    expect(request).toHaveBeenCalledExactlyOnceWith("tasks.get", { taskId: "task-other" });
  });
});
