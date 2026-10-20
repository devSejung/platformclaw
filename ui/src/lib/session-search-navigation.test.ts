import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { pages } from "../pages/chat/route.ts";
import {
  navigateToSessionSearchHit,
  sessionSearchTargetFromLocation,
} from "./session-search-navigation.ts";

describe("session search navigation", () => {
  it("opens a dashboard-preferred result as chat and retains the exact message in the fragment", () => {
    const navigate = vi.fn();
    const sessionKey = "agent:main:launch";
    const context = {
      basePath: "/platformclaw/app",
      navigate,
      gateway: { snapshot: { hello: null } },
      agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
      agentSelection: { state: { selectedId: "main" } },
      sessions: { state: { result: { sessions: [{ key: sessionKey, boardFace: "dashboard" }] } } },
    } as unknown as ApplicationContext;
    const target = {
      sessionKey,
      sessionId: "transcript-1",
      messageId: "message-7",
      query: "로그인 & 배포",
    };
    navigateToSessionSearchHit(context, target);
    const [face, options] = navigate.mock.calls[0]!;
    expect(face).toBe("chat");
    expect(options.pathname).toContain("/chat/");
    expect(options.search ?? "").not.toContain("find");
    expect(sessionSearchTargetFromLocation(options, sessionKey)).toEqual(target);
  });

  it("ignores ordinary fragments and caps highlight input", () => {
    expect(sessionSearchTargetFromLocation({ hash: "#heading" }, "main")).toBeUndefined();
    const hash = `#${new URLSearchParams({ transcript: "s", message: "m", find: "a".repeat(5000) })}`;
    expect(sessionSearchTargetFromLocation({ hash }, "main")?.query).toHaveLength(4096);
  });

  it("makes message fragments loader dependencies without reloading ordinary document headings", () => {
    const context = { basePath: "" } as ApplicationContext;
    const location = { pathname: "/chat/main", search: "", hash: "" };
    const deps = (hash: string) => pages[0].loaderDeps?.(context, { ...location, hash });
    expect(deps("#control-ui-main")).toBe(deps(""));
    expect(deps("#transcript=s&message=one&find=word")).not.toBe(deps(""));
    expect(deps("#transcript=s&message=one&find=word")).not.toBe(
      deps("#transcript=s&message=two&find=word"),
    );
  });
});
