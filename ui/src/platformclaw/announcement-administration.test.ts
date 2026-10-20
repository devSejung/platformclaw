/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnouncementAdministrationSnapshot } from "../../../packages/platformclaw-control-plane/src/announcement-contracts.js";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./announcement-administration.ts";

const EMPTY: AnnouncementAdministrationSnapshot = {
  revision: 0,
  serverNow: Date.now(),
  announcement: null,
  current: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mount(fetchImpl: typeof fetch, onUnauthenticated = vi.fn()) {
  const element = document.createElement(
    "platformclaw-announcement-administration",
  ) as HTMLElement & {
    fetchImpl: typeof fetch;
    onUnauthenticated: () => void;
  };
  element.fetchImpl = fetchImpl;
  element.onUnauthenticated = onUnauthenticated;
  document.body.append(element);
  return element;
}

function fill(root: ShadowRoot, name: string, value: string): void {
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name='${name}']`)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function ready(element: HTMLElement): Promise<ShadowRoot> {
  const root = element.shadowRoot!;
  await vi.waitFor(() =>
    expect(root.querySelector<HTMLButtonElement>("form button")?.disabled).toBe(false),
  );
  return root;
}

afterEach(async () => {
  document.querySelector("platformclaw-announcement-administration")?.remove();
  await i18n.setLocale("en");
});

describe("announcement administration page", () => {
  it.each(["en", "ko"] as const)(
    "loads inline and previews a revision-pinned publish in %s",
    async (locale) => {
      await i18n.setLocale(locale);
      await loadPlatformClawLocale();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(EMPTY))
        .mockResolvedValueOnce(jsonResponse({ ...EMPTY, revision: 1 }));
      const root = await ready(mount(fetchImpl));
      expect(root.querySelector(".launcher, openclaw-modal-dialog, h2")).toBeNull();
      fill(root, "title", "Draft title");
      fill(root, "body", "Plain <script>text</script>");
      fill(root, "expiresAt", "2099-01-01T12:00");
      root.querySelector<HTMLFormElement>("form")!.requestSubmit();
      await vi.waitFor(() =>
        expect(root.querySelector(".preview")?.textContent).toContain("Draft title"),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(root.querySelector("script")).toBeNull();
      root.querySelector<HTMLButtonElement>(".preview button")!.click();
      await vi.waitFor(() => expect(root.querySelector("[role='status']")).not.toBeNull());
      const body = fetchImpl.mock.calls[1]?.[1]?.body;
      expect(typeof body).toBe("string");
      expect(JSON.parse(body as string)).toEqual({
        action: "publish",
        expectedRevision: 0,
        title: "Draft title",
        body: "Plain <script>text</script>",
        kind: "general",
        maintenanceAt: null,
        expiresAt: new Date("2099-01-01T12:00").getTime(),
      });
    },
  );

  it("keeps a new page draft when an earlier connection's load completes last", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((complete) => {
      resolve = complete;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(jsonResponse(EMPTY));
    const element = mount(fetchImpl);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    element.remove();
    document.body.append(element);
    const root = await ready(element);
    fill(root, "title", "Keep my new draft");
    resolve(
      jsonResponse({
        ...EMPTY,
        current: {
          id: "old",
          revision: 1,
          title: "Stale title",
          body: "Old",
          kind: "general",
          maintenanceAt: null,
          expiresAt: Date.now() + 60_000,
          cancelled: false,
        },
      }),
    );
    await new Promise<void>((complete) => {
      setTimeout(complete, 0);
    });
    expect(root.querySelector<HTMLInputElement>("[name='title']")?.value).toBe("Keep my new draft");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves the preview after a revision conflict", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(EMPTY))
      .mockResolvedValueOnce(jsonResponse({ error: "Announcement changed; reload" }, 409));
    const root = await ready(mount(fetchImpl));
    fill(root, "title", "Draft");
    fill(root, "body", "Message");
    fill(root, "expiresAt", "2099-01-01T12:00");
    root.querySelector<HTMLFormElement>("form")!.requestSubmit();
    await vi.waitFor(() => expect(root.querySelector(".preview")).not.toBeNull());
    root.querySelector<HTMLButtonElement>(".preview button")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector("[role='alert']")?.textContent).toContain(
        "Announcement changed; reload",
      ),
    );
    expect(root.querySelector(".preview")?.textContent).toContain("Draft");
  });

  it("ignores a retired page's authentication failure", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((complete) => {
      resolve = complete;
    });
    const onUnauthenticated = vi.fn();
    const staleFetch = vi.fn<typeof fetch>(() => pending);
    const element = mount(staleFetch, onUnauthenticated);
    await vi.waitFor(() => expect(staleFetch).toHaveBeenCalledOnce());
    element.remove();
    resolve(jsonResponse({ error: "authentication required" }, 401));
    await new Promise<void>((complete) => {
      setTimeout(complete, 0);
    });
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });
});
