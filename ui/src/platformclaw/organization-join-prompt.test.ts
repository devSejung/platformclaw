import { afterEach, describe, expect, it, vi } from "vitest";
import { translations as english } from "./locales/en-guide.ts";
import { translations as korean } from "./locales/ko.ts";
import { ORGANIZATION_JOIN_PROMPT_DISMISSED_KEY } from "./organization-join-prompt.ts";

type JoinPrompt = HTMLElement & {
  fetchImpl: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  updateComplete: Promise<unknown>;
};

function context(joinPromptEligible: boolean, actorId = "user-a") {
  return new Response(JSON.stringify({ actor: { id: actorId }, joinPromptEligible }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function settle(element: JoinPrompt): Promise<void> {
  await element.updateComplete;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await element.updateComplete;
}

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe("PlatformClaw organization join prompt", () => {
  it("keeps the complete join and prompt key set aligned in English and Korean", () => {
    const keys = Object.keys(english).filter(
      (key) =>
        key.startsWith("platformClaw.organization.join.") ||
        key.startsWith("platformClaw.organization.prompt."),
    );
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((key) => !(key in korean))).toEqual([]);
  });

  it("is dismissible for the current actor without blocking another actor", async () => {
    const first = document.createElement("platformclaw-organization-join-prompt") as JoinPrompt;
    first.storage = sessionStorage;
    first.fetchImpl = vi.fn(async () => context(true));
    document.body.append(first);
    await settle(first);
    expect(first.textContent).toContain("Join");
    first.querySelector<HTMLButtonElement>("button")!.click();
    await settle(first);
    expect(sessionStorage.getItem(ORGANIZATION_JOIN_PROMPT_DISMISSED_KEY)).toBe("user-a");

    const second = document.createElement("platformclaw-organization-join-prompt") as JoinPrompt;
    second.storage = sessionStorage;
    second.fetchImpl = vi.fn(async () => context(true, "user-b"));
    document.body.append(second);
    await settle(second);
    expect(second.querySelector("a")?.getAttribute("href")).toContain("tab=requests");
  });

  it("stays hidden when the server says the actor is affiliated, pending, or admin", async () => {
    const element = document.createElement("platformclaw-organization-join-prompt") as JoinPrompt;
    element.storage = sessionStorage;
    element.fetchImpl = vi.fn(async () => context(false));
    document.body.append(element);
    await settle(element);
    expect(element.textContent?.trim()).toBe("");
  });

  it("keeps dismissal effective when session storage is unavailable", async () => {
    const element = document.createElement("platformclaw-organization-join-prompt") as JoinPrompt;
    element.storage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    element.fetchImpl = vi.fn(async () => context(true, "authoritative-user"));
    document.body.append(element);
    await settle(element);

    element.querySelector<HTMLButtonElement>("button")!.click();
    await settle(element);
    expect(element.textContent?.trim()).toBe("");
  });
});
