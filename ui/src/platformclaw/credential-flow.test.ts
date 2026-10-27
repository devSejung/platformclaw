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
  const user: Record<string, unknown> = {
    role: "user",
    __openclaw: { idempotencyKey: "source-run:user" },
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
    handleSendChat: vi.fn(),
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
  const toast = document.createElement("openclaw-toast-host");
  document.body.append(container, toast);
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
    toast,
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
  it("matches a persisted top-level user idempotency key to its source run", async () => {
    const f = setup();
    const history = f.getHistory();
    const user = {
      ...history.messages[0],
      __openclaw: {},
      idempotencyKey: "source-run:user",
    };
    f.setHistory({ ...history, messages: [user] });
    f.host.chatMessages = [user];
    await f.ready();
    await f.configure();
    expect(f.flow.target?.envName).toBe("REPORT_API_TOKEN");
  });

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

  it("completes a confirmed save in place and dismisses the handoff without sending a turn", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    expect(f.flow.target).toEqual({
      requestId: REQUEST_ID,
      envName: "REPORT_API_TOKEN",
      expectedAccountId: "synthetic-a",
    });
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
    const form = document.createElement("div") as HTMLDivElement & { target?: unknown };
    f.flow.bindForm(form);
    expect(form.target).toEqual(f.flow.target);
    f.save();
    expect(f.flow.target).toBeUndefined();
    expect(form.target).toBeUndefined();
    f.draw();
    expect(f.container.textContent).toBe("");
    expect(f.application.navigate).toHaveBeenCalledExactlyOnceWith("credentials");
    expect(f.application.gateway.setSessionKey).not.toHaveBeenCalled();
    await f.toast.updateComplete;
    expect(f.toast.querySelector(".app-toast--bottom-right")).not.toBeNull();
    expect(f.toast.querySelector(".app-toast__action")?.textContent?.trim()).toBe("Back to chat");
    f.flow.visit("chat");
    f.draw();
    expect(f.container.textContent).toBe("");
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
  });

  it("offers an optional return to the source conversation without sending a turn", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    f.save();
    await f.toast.updateComplete;
    f.toast.querySelector<HTMLButtonElement>(".app-toast__action")!.click();
    await f.toast.updateComplete;
    expect(f.application.agentSelection.set).toHaveBeenCalledWith("personal");
    expect(f.application.gateway.setSessionKey).toHaveBeenCalledWith("agent:personal:main");
    expect(f.application.navigate).toHaveBeenLastCalledWith("chat", {
      pathname: "/platformclaw/app/chat/personal",
    });
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
    expect(f.toast.querySelector(".app-toast")).toBeNull();
  });

  it("does not offer a return action for a save without a chat handoff", async () => {
    const f = setup();
    f.save();
    await f.toast.updateComplete;
    expect(f.toast.querySelector(".app-toast")).toBeNull();
    expect(f.application.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate from a saved notification after its flow owner is disposed", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
    f.save();
    await f.toast.updateComplete;
    f.flow.dispose();
    f.toast.querySelector<HTMLButtonElement>(".app-toast__action")!.click();
    expect(f.application.navigate).toHaveBeenCalledExactlyOnceWith("credentials");
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
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
    "invalidates an editing request when %s changes",
    async (change) => {
      const f = setup();
      await f.ready();
      await f.configure();
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

  it("rechecks the server leaf before opening the form", async () => {
    const f = setup();
    await f.ready();
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
    expect(f.application.navigate).not.toHaveBeenCalled();
  });

  it("leaves a newer request intact when an older save acknowledgement arrives", async () => {
    const f = setup();
    await f.ready();
    await f.configure();
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
    f.save();
    f.draw();
    expect(f.container.querySelector("[data-credential-flow='awaiting-source']")).not.toBeNull();
    expect(f.host.handleSendChat).not.toHaveBeenCalled();
  });
});
