import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  classifyVmConnectionFailure,
  isSshpassAuthenticationFailure,
  PlatformClawVmAuthenticationError,
} from "./connection-errors.js";
import { registerPlatformClawExecutionGateway } from "./gateway.js";
import {
  PlatformClawTargetChangeError,
  PlatformClawTargetMutationCoordinator,
} from "./target-mutation-coordinator.js";

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type BeforeRunHandler = Parameters<OpenClawPluginApi["on"]>[1];

function createHarness(
  runtime: {
    testConnection: ReturnType<typeof vi.fn>;
    testCandidateConnection: ReturnType<typeof vi.fn>;
    changeTarget: ReturnType<typeof vi.fn>;
    detectCodingAgent?: ReturnType<typeof vi.fn>;
    checkCodingAgent?: ReturnType<typeof vi.fn>;
  },
  readiness: Promise<void> = Promise.resolve(),
) {
  const methods = new Map<string, GatewayHandler>();
  let beforeRun: BeforeRunHandler | undefined;
  const api = {
    logger: { warn: vi.fn() },
    on: vi.fn((name: string, handler: BeforeRunHandler) => {
      if (name === "before_agent_run") {
        beforeRun = handler;
      }
    }),
    registerGatewayMethod: vi.fn((name: string, handler: GatewayHandler) => {
      methods.set(name, (request) => {
        const context = request.context;
        return handler({
          ...request,
          context: {
            ...context,
            tryAcquireAgentWorkMutation: context?.tryAcquireAgentWorkMutation ?? (() => () => {}),
            hasPendingAgentWork:
              context?.hasPendingAgentWork ??
              ((agentId) =>
                [
                  ...(context?.chatAbortControllers?.values() ?? []),
                  ...(context?.chatQueuedTurns?.values() ?? []),
                ].some((entry) => entry.agentId === agentId)),
          },
        });
      });
    }),
  };
  const targetMutations = new PlatformClawTargetMutationCoordinator();
  const invalidateAcpProcesses = vi.fn();
  registerPlatformClawExecutionGateway(
    api as never,
    readiness.then(() => runtime as never),
    targetMutations,
    invalidateAcpProcesses,
  );
  return { beforeRun: () => beforeRun!, methods, targetMutations, invalidateAcpProcesses };
}

describe("SafeConnect authentication failure classification", () => {
  it("accepts both normalized command codes and transport exit codes", () => {
    expect(isSshpassAuthenticationFailure({ code: 5 })).toBe(true);
    expect(isSshpassAuthenticationFailure({ exitCode: 5 })).toBe(true);
    expect(isSshpassAuthenticationFailure({ code: 255 })).toBe(false);
  });

  it.each(["keyboard-interactive", "publickey,keyboard-interactive"])(
    "recognizes OpenSSH final authentication rejection with methods %s",
    (methods) => {
      const stderr = `employee@host: Permission denied (${methods}).\r\n`;
      expect(isSshpassAuthenticationFailure({ code: 255, stderr })).toBe(true);
      expect(isSshpassAuthenticationFailure({ exitCode: 255, stderr: Buffer.from(stderr) })).toBe(
        true,
      );
    },
  );

  it.each([
    "ssh: connect to host safe.example.test port 22: Connection refused\n",
    "Host key verification failed.\n",
    "employee@host: Permission denied (publickey).\n",
    "employee@host: Permission denied (keyboard-interactive).\nConnection closed by host\n",
    "Permission denied\n",
  ])("does not infer rejected AD credentials from a generic SSH failure: %s", (stderr) => {
    expect(isSshpassAuthenticationFailure({ code: 255, stderr })).toBe(false);
  });

  it("omits non-scalar transport codes from diagnostics", () => {
    const error = Object.assign(new Error("connection failed"), { code: { nested: true } });

    expect(classifyVmConnectionFailure(error).diagnostic).toBe("Error; connection failed");
  });
});

describe("PlatformClaw execution Gateway methods", () => {
  describe.each([
    "testConnection",
    "testCandidateConnection",
    "changeTarget",
    "detectCodingAgent",
    "checkCodingAgent",
  ] as const)("%s host admission fence", (method) => {
    const params = {
      agentId: "person_one",
      target: method === "changeTarget" ? "platform_server" : { agentId: "person_one" },
      expectedRevision: 1,
      agent: "codex",
      configuration: { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
      credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
      credentialGrantToken: "grant-token",
    };

    it("rejects non-chat work before awaiting or contacting the runtime", async () => {
      const runtime = {
        testConnection: vi.fn(),
        testCandidateConnection: vi.fn(),
        changeTarget: vi.fn(),
        detectCodingAgent: vi.fn(),
        checkCodingAgent: vi.fn(),
      };
      const harness = createHarness(runtime);
      const respond = vi.fn();
      const acquire = vi.fn(() => null);
      await harness.methods.get(`platformclaw-execution.${method}`)!({
        params,
        context: {
          chatAbortControllers: new Map(),
          chatQueuedTurns: new Map(),
          tryAcquireAgentWorkMutation: acquire,
        },
        respond,
      } as never);
      expect(acquire).toHaveBeenCalledExactlyOnceWith("person_one");
      expect(runtime[method]).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(harness.targetMutations.isHeld("person_one")).toBe(false);
    });

    it("holds host admission through remote work and releases it on failure", async () => {
      let reject!: (error: Error) => void;
      const pending = new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
      const runtime = {
        testConnection: vi.fn(() => pending),
        testCandidateConnection: vi.fn(() => pending),
        changeTarget: vi.fn(() => pending),
        detectCodingAgent: vi.fn(() => pending),
        checkCodingAgent: vi.fn(() => pending),
      };
      const harness = createHarness(runtime);
      const release = vi.fn();
      const changing = harness.methods.get(`platformclaw-execution.${method}`)!({
        params,
        context: {
          chatAbortControllers: new Map(),
          chatQueuedTurns: new Map(),
          tryAcquireAgentWorkMutation: () => release,
        },
        respond: vi.fn(),
      } as never);
      await vi.waitFor(() => expect(runtime[method]).toHaveBeenCalledOnce());
      expect(release).not.toHaveBeenCalled();
      reject(new Error("remote failure"));
      await changing;
      expect(release).toHaveBeenCalledOnce();
      expect(harness.targetMutations.isHeld("person_one")).toBe(false);
    });
  });

  describe.each(["testConnection", "testCandidateConnection"] as const)(
    "%s preparation",
    (method) => {
      const params = {
        ...(method === "testConnection"
          ? { agentId: "person_one" }
          : { target: { agentId: "person_one" } }),
        credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
        credentialGrantToken: "grant-token",
      };

      it.each([
        "active",
        "queued",
        "skill-install",
        "skill-export",
        "skill-workshop",
        "terminal-open",
      ] as const)("rejects %s work before creating the candidate workspace", async (busy) => {
        const runtime = {
          testConnection: vi.fn(),
          testCandidateConnection: vi.fn(),
          changeTarget: vi.fn(),
        };
        const harness = createHarness(runtime);
        const release =
          busy === "active" || busy === "queued"
            ? undefined
            : harness.targetMutations.tryAcquire("person_one", busy);
        const respond = vi.fn();
        const pending = new Map([["run", { agentId: "person_one" }]]);
        await harness.methods.get(`platformclaw-execution.${method}`)!({
          params,
          context: {
            chatAbortControllers: busy === "active" ? pending : new Map(),
            chatQueuedTurns: busy === "queued" ? pending : new Map(),
          },
          respond,
        } as never);
        expect(runtime[method]).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "CONFLICT" }),
        );
        release?.();
        expect(harness.targetMutations.isHeld("person_one")).toBe(false);
      });

      it("blocks new runs during preparation and releases the guard after failure", async () => {
        let reject!: (error: Error) => void;
        const pending = new Promise<never>((_resolve, fail) => {
          reject = fail;
        });
        const runtime = {
          testConnection: vi.fn(() => pending),
          testCandidateConnection: vi.fn(() => pending),
          changeTarget: vi.fn(),
        };
        const harness = createHarness(runtime);
        const respond = vi.fn();
        const probing = harness.methods.get(`platformclaw-execution.${method}`)!({
          params,
          context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
          respond,
        } as never);
        await vi.waitFor(() => expect(runtime[method]).toHaveBeenCalledOnce());
        expect(harness.beforeRun()({} as never, { agentId: "person_one" } as never)).toMatchObject({
          outcome: "block",
        });
        reject(new PlatformClawVmAuthenticationError());
        await probing;
        expect(harness.targetMutations.isHeld("person_one")).toBe(false);
        expect(harness.invalidateAcpProcesses).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { target: "assigned_vm", connectionId: "" },
    { target: "assigned_vm", connectionId: "   " },
    { target: "assigned_vm", connectionId: "x".repeat(129) },
    { target: "assigned_vm", connectionId: 3 },
    { target: "platform_server", connectionId: "connection-two" },
    { target: "assigned_vm", connectionId: "connection-two" },
    { target: "assigned_vm", connectionId: "connection-two", expectedConnectionRevision: 0 },
    { target: "assigned_vm", expectedConnectionRevision: 1 },
  ])("rejects an invalid saved VM target $target/$connectionId", async (selection) => {
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();
    await harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", expectedRevision: 1, ...selection },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(runtime.changeTarget).not.toHaveBeenCalled();
    expect(harness.invalidateAcpProcesses).not.toHaveBeenCalled();
  });

  it("activates a saved VM through the guarded switch and invalidates old ACP authority", async () => {
    const changed = { kind: "assigned_vm", allocationId: "allocation-two", revision: 2 };
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn().mockResolvedValue(changed),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();
    const params = {
      agentId: "person_one",
      target: "assigned_vm",
      expectedRevision: 1,
      connectionId: "connection-two",
      expectedConnectionRevision: 3,
    };
    await harness.methods.get("platformclaw-execution.changeTarget")!({
      params,
      context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
      respond,
    } as never);
    expect(runtime.changeTarget).toHaveBeenCalledExactlyOnceWith(params);
    expect(harness.invalidateAcpProcesses).toHaveBeenCalledExactlyOnceWith("person_one");
    expect(respond).toHaveBeenCalledWith(true, changed);
    expect(harness.targetMutations.isHeld("person_one")).toBe(false);
  });

  it("invalidates old ACP authority after a lost response confirms a committed target change", async () => {
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi
        .fn()
        .mockRejectedValue(
          new PlatformClawTargetChangeError(new Error("execution target response was aborted")),
        ),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();
    await harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "assigned_vm", expectedRevision: 1 },
      context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
      respond,
    } as never);
    expect(harness.invalidateAcpProcesses).toHaveBeenCalledExactlyOnceWith("person_one");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(harness.targetMutations.isHeld("person_one")).toBe(false);
  });

  it("routes only supported coding agent checks and redacts remote failures", async () => {
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(),
      checkCodingAgent: vi.fn().mockRejectedValue(new Error("secret remote output")),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();
    const handler = harness.methods.get("platformclaw-execution.checkCodingAgent")!;
    await handler({
      params: { agentId: "person_one", configuration: { agent: "other" }, expectedRevision: 9 },
      respond,
    } as never);
    expect(runtime.checkCodingAgent).not.toHaveBeenCalled();
    await handler({
      params: {
        agentId: "person_one",
        configuration: { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
        expectedRevision: 9,
      },
      respond,
    } as never);
    expect(runtime.checkCodingAgent).toHaveBeenCalledWith({
      agentId: "person_one",
      configuration: { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
      expectedRevision: 9,
    });
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("secret remote output");
  });
  it("classifies only an SSH authentication rejection for the BFF", async () => {
    const runtime = {
      testConnection: vi.fn(async () => {
        throw new PlatformClawVmAuthenticationError();
      }),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();

    await harness.methods.get("platformclaw-execution.testConnection")!({
      params: {
        agentId: "person_one",
        credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
        credentialGrantToken: "grant-token",
      },
      context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
      respond,
    } as never);

    expect(runtime.testConnection).toHaveBeenCalledWith({
      agentId: "person_one",
      credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
      credentialGrantToken: "grant-token",
    });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "development VM authentication failed; update the AD password and try again",
      details: { kind: "vm_authentication_failed" },
    });
  });

  it("preserves a categorized SSH cause for users and operators", async () => {
    const runtime = {
      testConnection: vi.fn(async () => {
        throw Object.assign(new Error("ssh: Could not resolve hostname safeconnect.invalid"), {
          code: 255,
        });
      }),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();

    await harness.methods.get("platformclaw-execution.testConnection")!({
      params: {
        agentId: "person_one",
        credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
        credentialGrantToken: "grant-token",
      },
      context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "SafeConnect host name could not be resolved",
      details: { kind: "vm_dns_failed" },
    });
  });

  it("rejects a work-location change while that agent has an active run", async () => {
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();

    await harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "assigned_vm", expectedRevision: 1 },
      context: {
        chatAbortControllers: new Map([["run-one", { agentId: "person_one" }]]),
        chatQueuedTurns: new Map(),
      },
      respond,
    } as never);

    expect(runtime.changeTarget).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });

  it.each([true, false])(
    "keeps a deferred turn on its original target until settlement (abortable=%s)",
    async (abortable) => {
      const runtime = {
        testConnection: vi.fn(),
        testCandidateConnection: vi.fn(),
        changeTarget: vi.fn().mockResolvedValue({ kind: "assigned_vm", revision: 2 }),
      };
      const harness = createHarness(runtime);
      const respond = vi.fn();
      const queued = new Map([
        [
          "queued-one",
          {
            agentId: "person_one",
            sessionId: "session-one",
            sessionKey: "agent:person_one:main",
            controller: new AbortController(),
            abortable,
          },
        ],
      ]);
      const request = {
        params: { agentId: "person_one", target: "assigned_vm", expectedRevision: 1 },
        context: { chatAbortControllers: new Map(), chatQueuedTurns: queued },
        respond,
      };
      const change = harness.methods.get("platformclaw-execution.changeTarget")!;

      await change(request as never);
      expect(runtime.changeTarget).not.toHaveBeenCalled();
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(queued.has("queued-one")).toBe(true);

      // The queue owner removes the settled turn. Another Agent's work remains independent.
      queued.delete("queued-one");
      queued.set("queued-two", {
        agentId: "person_two",
        sessionId: "session-two",
        sessionKey: "agent:person_two:main",
        controller: new AbortController(),
        abortable: true,
      });
      await change(request as never);
      expect(runtime.changeTarget).toHaveBeenCalledExactlyOnceWith(request.params);
      expect(respond).toHaveBeenLastCalledWith(true, { kind: "assigned_vm", revision: 2 });
    },
  );

  it("rechecks queued work admitted while the runtime becomes ready", async () => {
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(),
    };
    const harness = createHarness(runtime, readiness);
    const respond = vi.fn();
    const queued = new Map();
    const changing = harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "assigned_vm", expectedRevision: 1 },
      context: { chatAbortControllers: new Map(), chatQueuedTurns: queued },
      respond,
    } as never);
    expect(harness.beforeRun()({} as never, { agentId: "person_one" } as never)).toMatchObject({
      outcome: "block",
    });
    queued.set("queued-one", { agentId: "person_one" });
    ready();
    await changing;

    expect(runtime.changeTarget).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(harness.targetMutations.isHeld("person_one")).toBe(false);
  });

  it("blocks a new run until the atomic target change finishes", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(async () => {
        await pending;
        return {
          kind: "platform_server" as const,
          agentId: "person_one",
          targetId: "platform-server",
          revision: 2,
        };
      }),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();
    const changing = harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "platform_server", expectedRevision: 1 },
      context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
      respond,
    } as never);

    await vi.waitFor(() => expect(runtime.changeTarget).toHaveBeenCalledOnce());
    expect(harness.beforeRun()({} as never, { agentId: "person_one" } as never)).toMatchObject({
      outcome: "block",
    });
    release();
    await changing;
    expect(harness.beforeRun()({} as never, { agentId: "person_one" } as never)).toMatchObject({
      outcome: "pass",
    });
  });

  it.each(["skill-install", "skill-export", "skill-workshop", "terminal-open"] as const)(
    "rejects a saved VM switch during %s without blocking agent runs",
    async (kind) => {
      const runtime = {
        testConnection: vi.fn(),
        testCandidateConnection: vi.fn(),
        changeTarget: vi.fn(),
      };
      const harness = createHarness(runtime);
      const release = harness.targetMutations.tryAcquire("person_one", kind);
      const respond = vi.fn();

      await harness.methods.get("platformclaw-execution.changeTarget")!({
        params: {
          agentId: "person_one",
          target: "assigned_vm",
          expectedRevision: 1,
          connectionId: "connection-two",
          expectedConnectionRevision: 3,
        },
        context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
        respond,
      } as never);

      expect(runtime.changeTarget).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(harness.beforeRun()({} as never, { agentId: "person_one" } as never)).toMatchObject({
        outcome: "pass",
      });
      release?.();
    },
  );

  it("preserves an optimistic-revision conflict from the control plane", async () => {
    const runtime = {
      testConnection: vi.fn(),
      testCandidateConnection: vi.fn(),
      changeTarget: vi.fn(async () => {
        throw new Error("execution handoff request failed (409)");
      }),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();

    await harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "assigned_vm", expectedRevision: 1 },
      context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "CONFLICT",
      message: "work location changed before the requested update",
    });
    expect(harness.invalidateAcpProcesses).not.toHaveBeenCalled();
  });
});
