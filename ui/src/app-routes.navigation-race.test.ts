import type { RouteLoaderOptions, RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { createApplicationRouter, startApplicationRouter, type RouteId } from "./app-routes.ts";
import { bootstrapApplication } from "./app/bootstrap.ts";
import type { ApplicationContext } from "./app/context.ts";
import { loadPlatformClawChatRoute } from "./platformclaw/space-conversation-route.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function memoryHistory(initial: RouteLocation) {
  let current = initial;
  let listener: ((location: RouteLocation) => void) | undefined;
  const history: RouterHistory = {
    location: () => current,
    push: vi.fn((next) => {
      current = next;
    }),
    replace: vi.fn((next) => {
      current = next;
    }),
    listen: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    history,
    pop: (next: RouteLocation) => {
      current = next;
      listener?.(next);
    },
  };
}

const activeLocation = {
  pathname: "/spaces",
  search: "?space=current&page=one&conversation=first",
  hash: "",
};
const cases = (["space-redirect", "ordinary-success", "ordinary-error"] as const).flatMap(
  (outcome) => (["history", "navigate", "replace"] as const).map((via) => ({ outcome, via })),
);

describe("application navigation cancels a cold sibling before reusing the active match", () => {
  it.each(cases)(
    "keeps the active Space after $outcome returns through $via",
    async ({ outcome, via }) => {
      const previousUrl = window.location.href;
      window.history.replaceState({}, "", `${activeLocation.pathname}${activeLocation.search}`);
      const module = deferred<{ render: () => string }>();
      const response = deferred<unknown>();
      const request = vi.fn(() => response.promise);
      const gateway = {
        snapshot: { phase: "connected", client: { request } },
      } as unknown as ApplicationContext["gateway"];
      let staleSignal!: AbortSignal;
      const staleLoader = (context: ApplicationContext<RouteId>, options: RouteLoaderOptions) => {
        staleSignal = options.signal;
        return outcome === "space-redirect"
          ? loadPlatformClawChatRoute(
              { ...context, gateway },
              options.location,
              "chat",
              options.signal,
            )
          : response.promise;
      };
      const activeLoader = vi.fn(async () => "current Space");
      const runtime = bootstrapApplication({
        enabledRouteIds: ["spaces", "chat", "activity"],
        sessionPathBuilderReady: Promise.resolve(),
        routeOverrides: {
          spaces: {
            loaderDeps: (_context, location) => location.search,
            loader: activeLoader,
            component: async () => ({ render: () => "current Space" }),
          },
          chat: { loader: staleLoader, component: () => module.promise },
          activity: { loader: staleLoader, component: () => module.promise },
        },
      });
      const { history, pop } = memoryHistory(activeLocation);
      const navigate = vi.spyOn(runtime.router, "navigate");
      let pending: Promise<void> | undefined;
      try {
        // Start only the real router: bootstrap's actual context navigation runs
        // against deterministic history without starting a Gateway transport.
        await startApplicationRouter(runtime.router, history, "", runtime.context);
        const activeModule = runtime.router.getState().matches[0]?.module;
        const staleRoute = outcome === "space-redirect" ? "chat" : "activity";
        const staleLocation = {
          pathname:
            outcome === "space-redirect"
              ? "/chat/alice/space-session/12345678-90ab-cdef-1234-567890abcdef"
              : "/settings/activity",
          search: "",
          hash: "",
        };
        if (via === "history") {
          pop(staleLocation);
        } else {
          runtime.context.navigate(staleRoute, staleLocation);
        }
        pending = navigate.mock.results.at(-1)?.value as Promise<void>;
        await vi.waitFor(() => expect(staleSignal).toBeDefined());
        if (outcome === "space-redirect") {
          await vi.waitFor(() => expect(request).toHaveBeenCalled());
        }
        expect(runtime.router.getState().matches[0]?.routeId).toBe("spaces");
        expect(runtime.router.getState().pendingMatches[0]?.routeId).toBe(staleRoute);
        expect(staleSignal.aborted).toBe(false);
        const returnedLocation = { ...activeLocation, hash: via === "history" ? "" : "#latest" };
        if (via === "history") {
          pop(returnedLocation);
        } else {
          runtime.context[via]("spaces", returnedLocation);
        }
        expect(staleSignal.aborted).toBe(true);
        await vi.waitFor(() => expect(runtime.router.getState().status).toBe("success"));
        module.resolve({ render: () => "stale page" });
        if (outcome === "ordinary-error") {
          response.reject(new Error("retired request failed"));
        } else {
          response.resolve({ spaceId: "stale", pageId: "two", conversationId: "second" });
        }
        await pending;
        expect(history.location()).toEqual(returnedLocation);
        expect(runtime.router.getState().resolvedLocation).toEqual(returnedLocation);
        expect(runtime.router.getState().matches[0]).toMatchObject({
          routeId: "spaces",
          status: "success",
          data: "current Space",
        });
        expect(runtime.router.getState().matches[0]?.module).toBe(activeModule);
        expect(activeLoader).toHaveBeenCalledTimes(2);
      } finally {
        runtime.router.stop();
        module.resolve({ render: () => "stale page" });
        response.resolve(null);
        await pending?.catch(() => undefined);
        navigate.mockRestore();
        runtime.stop();
        window.history.replaceState({}, "", previousUrl);
      }
    },
  );

  it.each(["navigate", "history"] as const)(
    "normalizes a trailing-slash chat return before matching dependencies through %s",
    async (via) => {
      const context = { basePath: "" } as ApplicationContext<RouteId>;
      const module = deferred<{ render: () => string }>();
      let staleSignal!: AbortSignal;
      const chatLoader = vi.fn(async () => "active chat");
      const router = createApplicationRouter(["chat", "activity"], {
        chat: { loader: chatLoader, component: async () => ({ render: () => "active chat" }) },
        activity: {
          loader: (_context, { signal }) => {
            staleSignal = signal;
            return "stale activity";
          },
          component: () => module.promise,
        },
      });
      const chatLocation = { pathname: "/chat/alice", search: "", hash: "" };
      const { history, pop } = memoryHistory(chatLocation);
      let pending: Promise<void> | undefined;
      try {
        await startApplicationRouter(router, history, "", context);
        pending = router.navigate("activity", context, { history: "push" });
        await vi.waitFor(() => expect(staleSignal).toBeDefined());
        const returnedLocation = { ...chatLocation, pathname: "/chat/alice/" };
        if (via === "history") {
          pop(returnedLocation);
        } else {
          await router.navigate("chat", context, { history: "replace" }, returnedLocation);
        }
        expect(staleSignal.aborted).toBe(true);
        module.resolve({ render: () => "stale activity" });
        await pending;
        await vi.waitFor(() => expect(router.getState().status).toBe("success"));
        expect(router.getState().resolvedLocation).toEqual(chatLocation);
        expect(router.getState().matches[0]?.data).toBe("active chat");
        expect(chatLoader).toHaveBeenCalledTimes(2);
      } finally {
        router.stop();
        module.resolve({ render: () => "stale activity" });
        await pending?.catch(() => undefined);
      }
    },
  );

  it("does not revalidate an idle same-match return or a different Space selection", async () => {
    const context = { basePath: "" } as ApplicationContext<RouteId>;
    const loader = vi.fn(
      async (_context: ApplicationContext<RouteId>, options: RouteLoaderOptions) =>
        options.location.search,
    );
    const router = createApplicationRouter(["spaces"], {
      spaces: {
        loaderDeps: (_context, location) => location.search,
        loader,
        component: async () => ({ render: () => "Space" }),
      },
    });
    const { history } = memoryHistory(activeLocation);
    try {
      await startApplicationRouter(router, history, "", context);
      await router.navigate(
        "spaces",
        context,
        { history: "replace" },
        { ...activeLocation, hash: "#latest" },
      );
      expect(loader).toHaveBeenCalledTimes(1);
      await router.navigate(
        "spaces",
        context,
        { history: "push" },
        { ...activeLocation, search: "?space=other" },
      );
      expect(loader).toHaveBeenCalledTimes(2);
      expect(loader.mock.calls[1]?.[1].revalidating).toBe(false);
    } finally {
      router.stop();
    }
  });
});
