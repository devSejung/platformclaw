/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformClawSkillHubDetail } from "../../platformclaw/skill-hub.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { SkillHubEditController } from "./edit-controller.ts";
import { skillHubRequestBody } from "./skill-hub.test-fixtures.ts";
import {
  skillHubConfig,
  skillHubDetail,
  skillHubEntry,
  skillHubJson,
  skillHubRequestUrl,
} from "./skill-hub.test-fixtures.ts";

function openEditor(detail = skillHubDetail(), config = skillHubConfig()) {
  const container = document.createElement("div");
  document.body.append(container);
  const refresh = vi.fn(async () => undefined);
  const controller = new SkillHubEditController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      updateComplete: Promise.resolve(true),
      requestUpdate: () => render(html`${controller.renderDialog()}`, container),
    },
    { refresh, setMessage: vi.fn() },
  );
  controller.request({ id: detail.skill.id, slug: detail.skill.slug }, detail, config);
  return {
    container,
    controller,
    refresh,
    input(name: string, value: string) {
      const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[name="${name}"]`,
      )!;
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    },
    save: () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!,
    reload: () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Reload latest"),
      )!,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("Skill Hub catalog editing", () => {
  it.each([false, true])(
    "keeps metadata edits available and lets an owner remove an archived organization (sharing changed=%s)",
    async (changeSharing) => {
      const archived = { id: "archived-part", kind: "part" as const, name: "Archived Part" };
      const active = { id: "active-part", kind: "part" as const, name: "Active Part" };
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        const body = JSON.parse(skillHubRequestBody(init?.body));
        return body.sharing?.scopeIds.includes(archived.id)
          ? skillHubJson({ error: "Selected organization is unavailable" }, 400)
          : skillHubJson({ ok: true });
      });
      vi.stubGlobal("fetch", fetchMock);
      const detail = skillHubDetail({
        skill: skillHubEntry({ sharing: { mode: "SELECTED" } }),
        sharing: {
          mode: "SELECTED",
          userIds: [],
          scopeIds: [archived.id],
          users: [],
          scopes: [archived],
        },
      });
      const editor = openEditor(detail, skillHubConfig({ scopes: [active] }));
      editor.input("summary", "Updated catalog description");
      if (changeSharing) {
        editor.container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Remove unavailable organization Archived Part"]',
          )!
          .click();
        expect(editor.save().disabled).toBe(true);
        const checkbox = editor.container.querySelector<HTMLInputElement>('[value="active-part"]')!;
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
      editor.save().click();
      await waitForFast(() => expect(editor.refresh).toHaveBeenCalledOnce());
      const body = JSON.parse(skillHubRequestBody(fetchMock.mock.calls[0]![1]?.body));
      expect(body.summary).toBe("Updated catalog description");
      if (changeSharing) {
        expect(body.sharing).toEqual({ mode: "SELECTED", userIds: [], scopeIds: [active.id] });
      } else {
        expect(body).not.toHaveProperty("sharing");
      }
    },
  );

  it("saves description and tags without resetting private sharing or creating a package version", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => skillHubJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const refresh = vi.fn(async () => undefined);
    const controller = new SkillHubEditController(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        updateComplete: Promise.resolve(true),
        requestUpdate: () => render(html`${controller.renderDialog()}`, container),
      },
      { refresh, setMessage: vi.fn() },
    );
    const detail = skillHubDetail({
      skill: skillHubEntry({ sharing: { mode: "PRIVATE" } }),
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [], users: [], scopes: [] },
    });
    controller.request({ id: detail.skill.id, slug: detail.skill.slug }, detail, skillHubConfig());
    const summary = container.querySelector<HTMLTextAreaElement>('[name="summary"]')!;
    summary.value = "New catalog description";
    summary.dispatchEvent(new Event("input", { bubbles: true }));
    const tags = container.querySelector<HTMLInputElement>('[name="tags"]')!;
    tags.value = "one, two, three, four, five, six";
    tags.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
      true,
    );
    tags.value = "docs, release";
    tags.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await waitForFast(() => expect(refresh).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain(`/skills/by-id/${detail.skill.id}`);
    expect(init).toMatchObject({ method: "PATCH" });
    const body = JSON.parse(skillHubRequestBody(init?.body));
    expect(body).toEqual({
      expectedRevision: 7,
      displayName: "Demo",
      summary: "New catalog description",
      tags: ["docs", "release"],
    });
    expect(body).not.toHaveProperty("sharing");
  });

  it("retains unsaved work after a stale revision rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => skillHubJson({ error: "Skill changed; reload before editing." }, 409)),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const controller = new SkillHubEditController(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        updateComplete: Promise.resolve(true),
        requestUpdate: () => render(html`${controller.renderDialog()}`, container),
      },
      { refresh: vi.fn(), setMessage: vi.fn() },
    );
    const detail = skillHubDetail();
    controller.request({ id: detail.skill.id, slug: "demo" }, detail, skillHubConfig());
    const name = container.querySelector<HTMLInputElement>('[name="displayName"]')!;
    name.value = "My unsaved change";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await waitForFast(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Skill changed"),
    );
    expect(container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe(
      "My unsaved change",
    );
  });

  it("reloads the latest revision for comparison while keeping the draft and newly private sharing", async () => {
    const latest = skillHubDetail({
      skill: skillHubEntry({
        revision: 9,
        displayName: "Saved elsewhere",
        summary: "Latest saved description",
        tags: ["saved"],
        sharing: { mode: "PRIVATE" },
      }),
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [], users: [], scopes: [] },
    });
    const writes: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "PATCH") {
        writes.push(JSON.parse(skillHubRequestBody(init.body)));
        return writes.length === 1
          ? skillHubJson({ error: "Skill changed; reload before editing." }, 409)
          : skillHubJson({ ok: true });
      }
      return skillHubJson(
        skillHubRequestUrl(input).endsWith("/config") ? skillHubConfig() : latest,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const editor = openEditor();
    editor.input("displayName", "My name draft");
    editor.input("summary", "My description draft");
    editor.input("tags", "draft, release");
    editor.save().click();
    await waitForFast(() => expect(editor.reload()).toBeTruthy());
    expect(editor.save().disabled).toBe(true);
    editor.save().click();
    expect(writes).toHaveLength(1);
    editor.reload().click();
    await waitForFast(() =>
      expect(editor.container.textContent).toContain("Latest saved description"),
    );
    expect(writes).toHaveLength(1);
    expect(editor.container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe(
      "My name draft",
    );
    expect(editor.container.querySelector<HTMLTextAreaElement>('[name="summary"]')!.value).toBe(
      "My description draft",
    );
    expect(editor.container.querySelector<HTMLInputElement>('[name="tags"]')!.value).toBe(
      "draft, release",
    );
    expect(editor.container.querySelector<HTMLSelectElement>('[name="sharing"]')!.value).toBe(
      "PRIVATE",
    );
    editor.save().click();
    await waitForFast(() => expect(editor.refresh).toHaveBeenCalledOnce());
    expect(writes[1]).toEqual({
      expectedRevision: 9,
      displayName: "My name draft",
      summary: "My description draft",
      tags: ["draft", "release"],
    });
  });

  it("keeps a conflict blocked when reload fails and permits a read-only retry", async () => {
    let failRead = true;
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (init?.method === "PATCH") {
          patches++;
          return skillHubJson({ error: "Conflict" }, 409);
        }
        if (!skillHubRequestUrl(input).endsWith("/config") && failRead) {
          return skillHubJson({ error: "Temporarily unavailable" }, 503);
        }
        return skillHubJson(
          skillHubRequestUrl(input).endsWith("/config")
            ? skillHubConfig()
            : skillHubDetail({ skill: skillHubEntry({ revision: 8 }) }),
        );
      }),
    );
    const editor = openEditor();
    editor.input("summary", "Keep this draft");
    editor.save().click();
    await waitForFast(() => expect(editor.reload()).toBeTruthy());
    editor.reload().click();
    await waitForFast(() =>
      expect(editor.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Temporarily unavailable",
      ),
    );
    expect(editor.save().disabled).toBe(true);
    expect(editor.container.querySelector<HTMLTextAreaElement>('[name="summary"]')!.value).toBe(
      "Keep this draft",
    );
    failRead = false;
    editor.reload().click();
    await waitForFast(() => expect(editor.save().disabled).toBe(false));
    expect(patches).toBe(1);
  });

  it("retains an explicitly changed sharing choice and requires a reason after ownership changes", async () => {
    const latest = skillHubDetail({
      skill: skillHubEntry({ revision: 8 }),
      owner: { ...skillHubEntry().owner, isMine: false },
    });
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (init?.method === "PATCH") {
          writes.push(JSON.parse(skillHubRequestBody(init.body)));
          return writes.length === 1
            ? skillHubJson({ error: "Conflict" }, 409)
            : skillHubJson({ ok: true });
        }
        return skillHubJson(
          skillHubRequestUrl(input).endsWith("/config") ? skillHubConfig({ admin: true }) : latest,
        );
      }),
    );
    const editor = openEditor();
    const sharing = editor.container.querySelector<HTMLSelectElement>('[name="sharing"]')!;
    sharing.value = "PRIVATE";
    sharing.dispatchEvent(new Event("change", { bubbles: true }));
    editor.save().click();
    await waitForFast(() => expect(editor.reload()).toBeTruthy());
    editor.reload().click();
    await waitForFast(() =>
      expect(editor.container.querySelector('[name="adminReason"]')).toBeTruthy(),
    );
    expect(editor.container.querySelector<HTMLSelectElement>('[name="sharing"]')!.value).toBe(
      "PRIVATE",
    );
    expect(editor.save().disabled).toBe(true);
    editor.input("adminReason", "Owner requested this correction");
    editor.save().click();
    await waitForFast(() => expect(editor.refresh).toHaveBeenCalledOnce());
    expect(writes[1]).toMatchObject({
      expectedRevision: 8,
      reason: "Owner requested this correction",
      sharing: { mode: "PRIVATE" },
    });
  });

  it("keeps the draft copyable and the dialog closable after management access is lost", async () => {
    const latest = skillHubDetail({ canManage: false, sharing: undefined });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
      init?.method === "PATCH"
        ? skillHubJson({ error: "Conflict" }, 409)
        : skillHubJson(skillHubRequestUrl(input).endsWith("/config") ? skillHubConfig() : latest),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = openEditor();
    editor.input("summary", "Copy my work");
    editor.save().click();
    await waitForFast(() => expect(editor.reload()).toBeTruthy());
    editor.reload().click();
    await waitForFast(() =>
      expect(editor.container.querySelector('[role="alert"]')?.textContent).toContain(
        "no longer edit",
      ),
    );
    const summary = editor.container.querySelector<HTMLTextAreaElement>('[name="summary"]')!;
    expect(summary.value).toBe("Copy my work");
    expect(summary.disabled).toBe(false);
    expect(summary.readOnly).toBe(true);
    expect(editor.save().disabled).toBe(true);
    const close = editor.container.querySelector<HTMLButtonElement>("header button")!;
    expect(close.disabled).toBe(false);
    close.click();
    expect(editor.container.querySelector("form")).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("ignores a late reload after closing the dialog and opening a different skill", async () => {
    let resolveDetail!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (init?.method === "PATCH") {
          return skillHubJson({ error: "Conflict" }, 409);
        }
        if (skillHubRequestUrl(input).endsWith("/config")) {
          return skillHubJson(skillHubConfig());
        }
        return new Promise<Response>((resolve) => {
          resolveDetail = resolve;
        });
      }),
    );
    const editor = openEditor();
    editor.save().click();
    await waitForFast(() => expect(editor.reload()).toBeTruthy());
    editor.reload().click();
    await waitForFast(() => expect(resolveDetail).toBeTypeOf("function"));
    editor.container.querySelector<HTMLButtonElement>("header button")!.click();
    const other: PlatformClawSkillHubDetail = skillHubDetail({
      skill: skillHubEntry({ id: "other-skill", displayName: "Other skill" }),
    });
    editor.controller.request(
      { id: other.skill.id, slug: other.skill.slug },
      other,
      skillHubConfig(),
    );
    resolveDetail(
      skillHubJson(
        skillHubDetail({ skill: skillHubEntry({ displayName: "Late stale response" }) }),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.container.querySelector<HTMLInputElement>('[name="displayName"]')!.value).toBe(
      "Other skill",
    );
    expect(editor.container.textContent).not.toContain("Late stale response");
    expect(editor.save().disabled).toBe(false);
  });
});
