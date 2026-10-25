import { render } from "lit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApplicationChatToolResult, ApplicationContext } from "../app/context.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { PlatformClawCredentialFlow } from "./credential-flow.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";

beforeAll(loadAllPlatformClawLocales);

const REQUEST_ID = "d745f81c-6421-4d72-8b68-baf4c3f04e11";
const DEFINITION_TOKEN = "a".repeat(32);
const CREDENTIAL_TOKEN = "b".repeat(32);

function fixture() {
  const identity = {
    accountId: "synthetic-a",
    agentId: "personal",
    displayName: "Synthetic",
    department: "",
    globalRole: "member" as const,
  };
  const user = {
    role: "user",
    __openclaw: { idempotencyKey: "source-run" },
    content: [{ type: "text", text: "Run a synthetic report" }],
  };
  let history = {
    sessionId: "session-a",
    messages: [user],
    sessionInfo: { sessionId: "session-a", activeLeafEntryId: "leaf-source", hasActiveRun: false },
  };
  let metadata: {
    accountId: string;
    definitions: {
      envName: string;
      configured: boolean;
      revision: number;
      definitionToken: string;
      credentialToken: string | null;
    }[];
  } = {
    accountId: identity.accountId,
    definitions: [
      {
        envName: "REPORT_API_TOKEN",
        configured: false,
        revision: 1,
        definitionToken: DEFINITION_TOKEN,
        credentialToken: null,
      },
    ],
  };
  const client = { request: vi.fn(async () => history) };
  const hello = {};
  const listeners = new Set<(snapshot: unknown) => void>();
  const snapshot = { phase: "connected", client, hello, sessionKey: "agent:personal:main" };
  const application = {
    basePath: "/platformclaw/app",
    gateway: {
      snapshot,
      subscribe: (listener: (snapshot: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setSessionKey: vi.fn(),
    },
    agents: {
      state: {
        agentsList: { defaultId: "personal", mainKey: "main", agents: [{ id: "personal" }] },
      },
    },
    agentSelection: { state: { selectedId: "personal" }, set: vi.fn() },
    sessions: { state: { sessionsResult: null } },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const loadIdentity = vi.fn(async () => identity);
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const flow = new PlatformClawCredentialFlow(identity, fetchImpl as typeof fetch, loadIdentity);
  const host = {
    connected: true,
    client,
    hello,
    sessionKey: snapshot.sessionKey,
    currentSessionId: "session-a",
    connectionEpoch: 1,
    agentsSelectedId: "personal",
    assistantAgentId: "personal",
    chatMessages: [user],
    chatLoading: false,
    chatDisplayedLeafEntryId: "leaf-source",
    chatRunId: null,
    chatSending: false,
    chatQueue: [],
    selectedChatSessionArchived: false,
    requestUpdate: vi.fn(),
    handleSendChat: vi.fn(
      async (
        _message: string,
        options: { onAdmitted?: (value: { queueId: string; runId: string }) => void },
      ) => {
        options.onAdmitted?.({ queueId: "queue-a", runId: REQUEST_ID });
      },
    ),
  } as unknown as ChatPageHost;
  const result: ApplicationChatToolResult = {
    name: "platformclaw_credentials",
    toolCallId: "tool-a",
    runId: "source-run",
    sessionKey: host.sessionKey,
    agentId: "personal",
    details: {
      uiAction: {
        version: 1,
        kind: "settings",
        feature: "platformclaw.exec-credentials",
        requestId: REQUEST_ID,
        targetKey: "REPORT_API_TOKEN",
      },
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  flow.attach(application);
  const draw = () => render(flow.render(host), container);
  const ready = async () => {
    host.chatRunId = "source-run";
    flow.capture(host, result);
    host.chatRunId = null;
    draw();
    await vi.waitFor(() => {
      draw();
      expect(container.querySelector("[data-credential-flow='required']")).not.toBeNull();
    });
  };
  const configure = async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(application.navigate).toHaveBeenCalledWith("credentials"));
    flow.visit("credentials");
  };
  const save = (revision = 2, credentialToken = CREDENTIAL_TOKEN) => {
    metadata = {
      ...metadata,
      definitions: [
        {
          envName: "REPORT_API_TOKEN",
          configured: true,
          revision,
          definitionToken: DEFINITION_TOKEN,
          credentialToken,
        },
      ],
    };
    flow.saved({
      requestId: REQUEST_ID,
      envName: "REPORT_API_TOKEN",
      revision,
      definitionToken: DEFINITION_TOKEN,
      credentialToken,
    });
  };
  return {
    flow,
    host,
    result,
    container,
    draw,
    ready,
    configure,
    save,
    client,
    application,
    loadIdentity,
    fetchImpl,
    snapshot,
    listeners,
    setHistory: (next: typeof history) => {
      history = next;
    },
    getHistory: () => history,
  };
}

const flows: PlatformClawCredentialFlow[] = [];
afterEach(() => {
  for (const flow of flows.splice(0)) {
    flow.dispose();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function setup() {
  const value = fixture();
  flows.push(value.flow);
  return value;
}

describe("personal credential handoff", () => {
  it("captures the first live request before its user row and session snapshot arrive", async () => {
    const f = setup();
    f.host.chatMessages = [];
    f.host.currentSessionId = undefined;
    f.host.chatRunId = "source-run";
    f.flow.capture(f.host, f.result);
    f.draw();
    expect(f.container.querySelector("[data-credential-flow='awaiting-source']")).not.toBeNull();
    f.host.chatMessages = f.getHistory().messages;
    f.host.currentSessionId = "session-a";
    f.host.chatRunId = null;
    f.draw();
    await vi.waitFor(() => {
      f.draw();
      expect(f.container.querySelector("[data-credential-flow='required']")).not.toBeNull();
    });
  });

  it("accepts only the exact product tool/action and waits for authoritative source completion", async () => {
    const f = setup();
    f.flow.capture(f.host, { ...f.result, name: "exec" });
    f.draw();
    expect(f.container.textContent).toBe("");
    f.flow.capture(f.host, {
      ...f.result,
      details: {
        uiAction: { ...(f.result.details as { uiAction: object }).uiAction, url: "/other" },
      },
    });
    f.draw();
    expect(f.container.textContent).toBe("");
    f.host.chatRunId = "source-run";
    f.flow.capture(f.host, f.result);
    f.draw();
    expect(f.container.querySelector("[data-credential-flow='awaiting-source']")).not.toBeNull();
    expect(f.client.request).not.toHaveBeenCalled();
    f.host.chatRunId = null;
    f.draw();
    await vi.waitFor(() => {
      f.draw();
      expect(f.container.textContent).toContain("Add key");
    });
  });

  it("returns to the same session, preserves a mounting pane, and admits one explicit new turn", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    expect(f.flow.target).toEqual({
      requestId: REQUEST_ID,
      envName: "REPORT_API_TOKEN",
      expectedAccountId: "synthetic-a",
    });
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
    f.save();
    await f.flow.returnToConversation();
    expect(f.application.gateway.setSessionKey).toHaveBeenCalledWith("agent:personal:main");
    expect(f.application.navigate).toHaveBeenLastCalledWith(
      "chat",
      expect.objectContaining({ pathname: expect.stringContaining("/platformclaw/app/") }),
    );
    f.flow.visit("chat");
    f.host.chatLoading = true;
    f.host.currentSessionId = undefined;
    f.draw();
    expect(f.container.querySelector("[data-credential-flow='saved']")).not.toBeNull();
    f.host.chatLoading = false;
    f.host.currentSessionId = "session-a";
    f.draw();
    const button = f.container.querySelector("button") as HTMLButtonElement;
    button.click();
    button.click();
    await vi.waitFor(() => expect(f.host.handleSendChat).toHaveBeenCalledTimes(1));
    expect(f.host.handleSendChat).toHaveBeenCalledWith(
      expect.stringContaining("REPORT_API_TOKEN"),
      expect.objectContaining({
        runId: REQUEST_ID,
        ignoreReplyTarget: true,
        actionScope: {
          agentId: "personal",
          sessionKey: "agent:personal:main",
          sessionId: "session-a",
          expectedLeafEntryId: "leaf-source",
        },
      }),
    );
  });

  it("ends editing on Back and ignores a late save acknowledgement", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    f.flow.visit("chat");
    f.save();
    f.draw();
    expect(f.flow.target).toBeUndefined();
    expect(f.container.querySelector("[data-credential-flow='inactive']")).not.toBeNull();
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
  });

  it("ignores a delayed result from a completed older run", () => {
    const f = setup();
    f.host.chatMessages = [{ role: "user", id: "newer-user" }];
    f.flow.capture(f.host, f.result);
    f.draw();
    expect(f.container.textContent).toBe("");
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it.each(["session", "turn", "leaf", "archive"])(
    "invalidates a saved request when %s changes",
    async (change) => {
      const f = setup();
      await f.ready();
      await f.configure();
      f.save();
      f.flow.visit("chat");
      if (change === "session") {
        f.host.currentSessionId = "replacement";
      }
      if (change === "turn") {
        f.host.chatMessages = [{ role: "user", id: "another-user" }];
      }
      if (change === "leaf") {
        f.host.chatDisplayedLeafEntryId = "another-leaf";
      }
      if (change === "archive") {
        f.host.selectedChatSessionArchived = true;
      }
      f.draw();
      expect(f.container.querySelector("[data-credential-flow='inactive']")).not.toBeNull();
      expect(f.host.handleSendChat).not.toHaveBeenCalled();
    },
  );

  it("rechecks the cookie account before opening the form", async () => {
    const f = setup();
    await f.ready();
    f.loadIdentity.mockResolvedValueOnce({
      accountId: "synthetic-b",
      agentId: "personal",
      displayName: "Other",
      department: "",
      globalRole: "member",
    });
    (f.container.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      f.draw();
      expect(f.container.textContent).toContain("signed-in account changed");
    });
    expect(f.application.navigate).not.toHaveBeenCalled();
  });

  it("invalidates on reconnect even when the logical client is reused", async () => {
    const f = setup();
    await f.ready();
    for (const listener of f.listeners) {
      listener({ ...f.snapshot, hello: {} });
    }
    f.draw();
    expect(f.container.querySelector("[data-credential-flow='inactive']")).not.toBeNull();
    f.flow.saved({
      requestId: REQUEST_ID,
      envName: "REPORT_API_TOKEN",
      revision: 2,
      definitionToken: DEFINITION_TOKEN,
      credentialToken: CREDENTIAL_TOKEN,
    });
    expect(f.flow.target).toBeUndefined();
  });

  it("keeps a request available after rejected local admission, retaining its id", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    f.save();
    f.flow.visit("chat");
    vi.mocked(f.host.handleSendChat).mockResolvedValue(undefined);
    f.draw();
    (f.container.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.host.handleSendChat).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      f.draw();
      expect(f.container.querySelector("[data-credential-flow='saved']")).not.toBeNull();
    });
    expect(f.container.textContent).toContain("could not confirm");
  });

  it.each(["definitionToken", "credentialToken"] as const)(
    "does not continue after a same-revision replacement changes %s",
    async (changedToken) => {
      const f = setup();
      await f.ready();
      await f.configure();
      f.save();
      f.flow.visit("chat");
      f.fetchImpl.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accountId: "synthetic-a",
            definitions: [
              {
                envName: "REPORT_API_TOKEN",
                configured: true,
                revision: 2,
                definitionToken: DEFINITION_TOKEN,
                credentialToken: CREDENTIAL_TOKEN,
                [changedToken]: "c".repeat(32),
              },
            ],
          }),
        ),
      );
      f.draw();
      (f.container.querySelector("button") as HTMLButtonElement).click();
      await vi.waitFor(() => {
        f.draw();
        expect(f.container.textContent).toContain("expired");
      });
      expect(f.host.handleSendChat).not.toHaveBeenCalled();
    },
  );

  it("continues with the latest confirmed value when the requested key is saved again", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    f.save();
    f.save(3, "c".repeat(32));
    f.flow.visit("chat");
    f.draw();
    (f.container.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.host.handleSendChat).toHaveBeenCalledOnce());
  });

  it("rechecks the server leaf before continuing and never sends after a race", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    f.save();
    f.flow.visit("chat");
    f.setHistory({
      ...f.getHistory(),
      sessionInfo: { ...f.getHistory().sessionInfo, activeLeafEntryId: "server-new-leaf" },
    });
    f.draw();
    (f.container.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      f.draw();
      expect(f.container.querySelector("[data-credential-flow='inactive']")).not.toBeNull();
    });
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
  });

  it("leaves a newer request intact when an older admission finishes", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    f.save();
    f.flow.visit("chat");
    let finish!: () => void;
    vi.mocked(f.host.handleSendChat).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.draw();
    (f.container.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.host.handleSendChat).toHaveBeenCalledOnce());
    const options = vi.mocked(f.host.handleSendChat).mock.calls[0]?.[1] as {
      onAdmitted: () => void;
    };
    f.host.chatRunId = "next-source";
    f.host.chatMessages = [{ role: "user", __openclaw: { idempotencyKey: "next-source" } }];
    f.flow.capture(f.host, {
      ...f.result,
      runId: "next-source",
      details: {
        uiAction: {
          ...(f.result.details as { uiAction: object }).uiAction,
          requestId: "d745f81c-6421-4d72-8b68-baf4c3f04e12",
        },
      },
    });
    options.onAdmitted();
    finish();
    await Promise.resolve();
    f.draw();
    expect(f.container.querySelector("[data-credential-flow='awaiting-source']")).not.toBeNull();
  });
});
