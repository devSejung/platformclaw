import { expect, it, vi } from "vitest";
import { startKnoxGatewayAccount } from "./gateway.js";

const mocks = vi.hoisted(() => ({
  registerRoute: vi.fn(),
  createIngress: vi.fn(),
  createDelivery: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  registerPluginHttpRoute: mocks.registerRoute,
}));
vi.mock("./ingress.js", () => ({ createKnoxIngress: mocks.createIngress }));
vi.mock("./my-delivery.js", () => ({ createKnoxMyDelivery: mocks.createDelivery }));
vi.mock("./inbound.js", () => ({
  dispatchKnoxInbound: vi.fn(),
  sendKnoxQueuedNotice: vi.fn(),
}));
vi.mock("./input-routing.js", () => ({ resolveKnoxQuestionAnswerBinding: vi.fn() }));
vi.mock("./webhook-handler.js", () => ({ createKnoxWebhookHandler: vi.fn(() => vi.fn()) }));

it("registers v1 while recovery is pending and owns that recovery through shutdown", async () => {
  vi.useFakeTimers();
  const recovery = Promise.withResolvers<void>();
  const recover = vi.fn(() => recovery.promise);
  const unregister = vi.fn();
  let recoverySignal: AbortSignal | undefined;
  mocks.createDelivery.mockImplementation((options: { abortSignal: AbortSignal }) => {
    recoverySignal = options.abortSignal;
    return { recover, admit: vi.fn(), withRequest: vi.fn() };
  });
  const createIngress = () => ({
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    has: vi.fn(async () => false),
    admit: vi.fn(),
  });
  const legacy = createIngress();
  const personal = createIngress();
  mocks.createIngress.mockReturnValueOnce(legacy).mockReturnValueOnce(personal);
  mocks.registerRoute.mockReturnValue(unregister);
  const abort = new AbortController();
  let stopped = false;
  const run = startKnoxGatewayAccount({
    accountId: "default",
    cfg: {
      channels: {
        knox: {
          selfInSpaceEnabled: false,
          webhookSecret: "w".repeat(32),
          serviceToken: "s".repeat(32),
          outboundUrl: "http://cdep.test/outbound/send",
          controlPlaneUrl: "http://control.test/internal/knox/route",
        },
      },
    },
    abortSignal: abort.signal,
  }).then(() => {
    stopped = true;
  });
  try {
    expect(mocks.registerRoute).toHaveBeenCalledOnce();
    expect(legacy.start).toHaveBeenCalledOnce();
    expect(personal.start).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).toHaveBeenCalledOnce();

    abort.abort();
    expect(unregister).toHaveBeenCalledOnce();
    expect(recoverySignal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(legacy.stop).not.toHaveBeenCalled();
    expect(personal.stop).not.toHaveBeenCalled();
    recovery.resolve();
    await run;
    expect(stopped).toBe(true);
    expect(legacy.stop).toHaveBeenCalledOnce();
    expect(personal.stop).toHaveBeenCalledOnce();
  } finally {
    abort.abort();
    recovery.resolve();
    await run;
    vi.useRealTimers();
  }
});
