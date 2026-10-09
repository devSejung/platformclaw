import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function detail(slug: string, version = "1.0.0") {
  return {
    skill: {
      namespace: "engineering",
      slug,
      displayName: `Detail ${slug}`,
      summary: slug,
      visibility: "NAMESPACE_ONLY",
      status: "PUBLISHED",
    },
    versions: [{ version, status: "PUBLISHED", downloadAvailable: true }],
  };
}
function button(root: ParentNode, text: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  expect(found, text).toBeDefined();
  return found!;
}
async function mount(
  overrides: (url: string, init?: RequestInit) => Promise<Response> | undefined,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const override = overrides(url, init);
    if (override) {
      return override;
    }
    if (url.endsWith("/config")) {
      return response({ namespaces: ["engineering"], maxPackageBytes: 1024 });
    }
    if (url.endsWith("/install")) {
      return response({ ok: true, slug: "skill-b", version: "2.0.0", target: "platform_server" });
    }
    return response({
      total: 2,
      items: ["skill-a", "skill-b"].map((slug) => ({
        namespace: "engineering",
        slug,
        latestVersion: "1.0.0",
        summary: slug,
      })),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const page = document.createElement("openclaw-skill-hub-page");
  document.body.append(page);
  await waitForFast(() => expect(page.querySelectorAll(".skill-hub-card")).toHaveLength(2));
  return { page, fetchMock };
}
function open(page: HTMLElement, index: number) {
  page.querySelectorAll<HTMLButtonElement>(".skill-hub-card")[index]!.click();
}
async function close(page: HTMLElement) {
  button(page.querySelector("openclaw-modal-dialog")!, "Close").click();
  await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
}
async function settle() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function registerSkillHubDetailTests() {
  describe("Skill Hub detail request ownership", () => {
    beforeEach(async () => {
      await i18n.setLocale("en");
    });
    afterEach(() => {
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    });

    it.each(["before-new", "after-new", "error"])(
      "ignores stale detail %s without changing the installation target",
      async (order) => {
        const old = deferred();
        const current = deferred();
        const { page, fetchMock } = await mount((url) => {
          if (url.endsWith("/skill-a")) {
            return old.promise;
          }
          if (url.endsWith("/skill-b")) {
            return current.promise;
          }
          return undefined;
        });
        open(page, 0);
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull());
        await close(page);
        open(page, 1);
        await waitForFast(() =>
          expect(fetchMock.mock.calls.some(([url]) => requestUrl(url).endsWith("/skill-b"))).toBe(
            true,
          ),
        );
        if (order === "before-new") {
          old.resolve(response(detail("skill-a")));
          await settle();
          expect(page.querySelector(".skill-hub-install-actions")).toBeNull();
          expect(page.querySelector(".skill-hub-detail")?.textContent).not.toContain(
            "Detail skill-a",
          );
        }
        current.resolve(response(detail("skill-b", "2.0.0")));
        await waitForFast(() =>
          expect(page.querySelector(".skill-hub-detail h2")?.textContent).toBe("Detail skill-b"),
        );
        if (order !== "before-new") {
          old.resolve(
            order === "error"
              ? response({ error: "Stale detail error" }, 503)
              : response(detail("skill-a")),
          );
          await settle();
        }
        expect(page.querySelector(".skill-hub-detail h2")?.textContent).toBe("Detail skill-b");
        expect(page.textContent).not.toContain("Stale detail error");
        button(page, "Install to Basic Workspace").click();
        await waitForFast(() =>
          expect(fetchMock).toHaveBeenLastCalledWith(
            expect.stringContaining("/install"),
            expect.objectContaining({
              body: JSON.stringify({
                namespace: "engineering",
                slug: "skill-b",
                version: "2.0.0",
                destination: "platform_server",
              }),
            }),
          ),
        );
      },
    );

    it("invalidates a closed request when the same skill is reopened", async () => {
      const old = deferred();
      let reads = 0;
      const { page } = await mount((url) => {
        if (url.endsWith("/skill-a")) {
          return ++reads === 1
            ? old.promise
            : Promise.resolve(response(detail("skill-a", "2.0.0")));
        }
        return undefined;
      });
      open(page, 0);
      await waitForFast(() => expect(reads).toBe(1));
      await close(page);
      open(page, 0);
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLInputElement>("input[name='skill-hub-version']:checked")?.value,
        ).toBe("2.0.0"),
      );
      old.resolve(response(detail("skill-a")));
      await settle();
      expect(
        page.querySelector<HTMLInputElement>("input[name='skill-hub-version']:checked")?.value,
      ).toBe("2.0.0");
    });

    it("does not offer a stale replacement confirmation after changing skills", async () => {
      const install = deferred();
      const currentInstall = deferred();
      let installs = 0;
      const { page, fetchMock } = await mount((url) => {
        if (url.endsWith("/install")) {
          return ++installs === 1 ? install.promise : currentInstall.promise;
        }
        if (url.endsWith("/skill-a")) {
          return Promise.resolve(response(detail("skill-a")));
        }
        if (url.endsWith("/skill-b")) {
          return Promise.resolve(response(detail("skill-b", "2.0.0")));
        }
        return undefined;
      });
      open(page, 0);
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-install-actions")).not.toBeNull(),
      );
      button(page, "Install to Basic Workspace").click();
      await close(page);
      open(page, 1);
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-detail h2")?.textContent).toBe("Detail skill-b"),
      );
      expect(button(page, "Install to Basic Workspace").disabled).toBe(false);
      button(page, "Install to Basic Workspace").click();
      await settle();
      install.resolve(
        response(
          {
            error: "Replace old skill",
            details: {
              code: "existing-skill-replacement-required",
              currentVersion: "0.9.0",
              currentRevision: "old-revision",
              requestedVersion: "1.0.0",
              direction: "upgrade",
            },
          },
          409,
        ),
      );
      await settle();
      expect(page.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
      expect(page.textContent).not.toContain("Replace old skill");
      expect(
        fetchMock.mock.calls.filter(([url]) => requestUrl(url).endsWith("/install")),
      ).toHaveLength(2);
      expect(
        page.querySelector<HTMLButtonElement>(".skill-hub-install-actions button")!.disabled,
      ).toBe(true);
      currentInstall.resolve(
        response({ ok: true, slug: "skill-b", version: "2.0.0", target: "platform_server" }),
      );
      await waitForFast(() =>
        expect(button(page, "Install to Basic Workspace").disabled).toBe(false),
      );
    });
    it.each(["refresh-error", "closed"])(
      "keeps management completion owned by its detail: %s",
      async (outcome) => {
        const mutation = deferred();
        let reads = 0;
        const { page } = await mount((url) => {
          if (url.endsWith("/access/user-one")) {
            return mutation.promise;
          }
          if (url.endsWith("/skill-a")) {
            reads++;
            return Promise.resolve(
              reads > 1
                ? response({ error: "Detail refresh unavailable" }, 503)
                : response({
                    ...detail("skill-a"),
                    canManage: true,
                    access: [
                      {
                        userId: "user-one",
                        expiresAt: null,
                        inheritVersions: true,
                        grantedVersion: null,
                      },
                    ],
                  }),
            );
          }
          return undefined;
        });
        open(page, 0);
        await waitForFast(() =>
          expect(page.querySelector(".skill-hub-access-list")).not.toBeNull(),
        );
        page.querySelector<HTMLButtonElement>(".skill-hub-access-list button")!.click();
        if (outcome === "closed") {
          await close(page);
        }
        mutation.resolve(response({ ok: true, removed: true }));
        if (outcome === "closed") {
          await settle();
          expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
          expect(reads).toBe(1);
        } else {
          await waitForFast(() => expect(page.textContent).toContain("Individual access revoked."));
          expect(page.textContent).toContain("Detail refresh unavailable");
        }
      },
    );
    it("does not let a closed management operation unlock its successor", async () => {
      const old = deferred();
      const current = deferred();
      let mutations = 0;
      const { page } = await mount((url) => {
        if (url.endsWith("/access/user-one")) {
          return ++mutations === 1 ? old.promise : current.promise;
        }
        const slug = url.split("/").at(-1);
        if (slug === "skill-a" || slug === "skill-b") {
          return Promise.resolve(
            response({
              ...detail(slug),
              canManage: true,
              access: [
                {
                  userId: "user-one",
                  expiresAt: null,
                  inheritVersions: true,
                  grantedVersion: null,
                },
              ],
            }),
          );
        }
        return undefined;
      });
      open(page, 0);
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-access-list button")).not.toBeNull(),
      );
      page.querySelector<HTMLButtonElement>(".skill-hub-access-list button")!.click();
      await close(page);
      open(page, 1);
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-detail h2")?.textContent).toBe("Detail skill-b"),
      );
      const revoke = () => page.querySelector<HTMLButtonElement>(".skill-hub-access-list button")!;
      expect(revoke().disabled).toBe(false);
      revoke().click();
      await settle();
      old.resolve(response({ ok: true, removed: true }));
      await settle();
      expect(revoke().disabled).toBe(true);
      expect(page.querySelector(".skill-hub-detail h2")?.textContent).toBe("Detail skill-b");
      current.resolve(response({ ok: true, removed: true }));
      await waitForFast(() => expect(revoke().disabled).toBe(false));
      expect(mutations).toBe(2);
    });
    it.each(["detail", "query"])(
      "ignores management search errors after changing the %s",
      async (change) => {
        const search = deferred();
        const { page } = await mount((url) => {
          if (url.includes("/management-users")) {
            return search.promise;
          }
          const slug = url.split("/").at(-1);
          if (slug === "skill-a" || slug === "skill-b") {
            return Promise.resolve(response({ ...detail(slug), canManage: true }));
          }
          return undefined;
        });
        open(page, 0);
        await waitForFast(() =>
          expect(page.querySelector(".skill-hub-management input")).not.toBeNull(),
        );
        const input = page.querySelector<HTMLInputElement>(".skill-hub-management input")!;
        input.value = "old query";
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        if (change === "detail") {
          await close(page);
          open(page, 1);
          await waitForFast(() =>
            expect(page.querySelector(".skill-hub-detail h2")?.textContent).toBe("Detail skill-b"),
          );
        } else {
          input.value = "";
          input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }
        search.resolve(response({ error: "Stale user search error" }, 503));
        await settle();
        expect(page.textContent).not.toContain("Stale user search error");
      },
    );

    it.each(["install", "management"])(
      "serializes detail mutations while %s is pending",
      async (first) => {
        const installation = deferred();
        const management = deferred();
        let installs = 0;
        let mutations = 0;
        const { page } = await mount((url) => {
          if (url.endsWith("/install")) {
            installs++;
            return installation.promise;
          }
          if (url.endsWith("/access/user-one")) {
            mutations++;
            return management.promise;
          }
          if (url.endsWith("/skill-a")) {
            return Promise.resolve(
              response({
                ...detail("skill-a"),
                canManage: true,
                access: [
                  {
                    userId: "user-one",
                    expiresAt: null,
                    inheritVersions: true,
                    grantedVersion: null,
                  },
                ],
              }),
            );
          }
          return undefined;
        });
        open(page, 0);
        await waitForFast(() =>
          expect(page.querySelector(".skill-hub-access-list button")).not.toBeNull(),
        );
        const revoke = () =>
          page.querySelector<HTMLButtonElement>(".skill-hub-access-list button")!;
        const installButton = () =>
          page.querySelector<HTMLButtonElement>(".skill-hub-install-actions button")!;
        (first === "install" ? installButton() : revoke()).click();
        await settle();
        expect(installButton().disabled).toBe(true);
        expect(revoke().disabled).toBe(true);
        (first === "install" ? revoke() : installButton()).click();
        expect(installs).toBe(first === "install" ? 1 : 0);
        expect(mutations).toBe(first === "management" ? 1 : 0);
        if (first === "install") {
          installation.resolve(response({ error: "Installation failed visibly" }, 503));
          await waitForFast(() =>
            expect(page.textContent).toContain("Installation failed visibly"),
          );
        } else {
          management.resolve(response({ ok: true, removed: true }));
          await waitForFast(() => expect(page.textContent).toContain("Individual access revoked."));
        }
        expect(installButton().disabled).toBe(false);
        expect(revoke().disabled).toBe(false);
      },
    );
  });
}
