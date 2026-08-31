import type { GatewayBrowserClient } from "../../api/gateway.ts";

type MemoryMemoriesTestElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionPhase: "stopped" | "connecting" | "connected" | "reconnecting" | "offline" | "";
  methodAdvertised: boolean | null;
  wikiSearchAdvertised: boolean | null;
  browseEnabled: boolean;
  browseListAdvertised: boolean | null;
  personalDetailAdvertised: boolean | null;
  wikiGetAdvertised: boolean | null;
  organizationGetAdvertised: boolean | null;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

export type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createElement(
  request: Request,
  advertised = true,
  options: {
    browse?: boolean;
    browseList?: boolean | null;
    connectionPhase?: MemoryMemoriesTestElement["connectionPhase"];
    organizationGet?: boolean | null;
    personalDetail?: boolean | null;
    wikiGet?: boolean | null;
    wikiSearch?: boolean | null;
  } = {},
) {
  const element = document.createElement("openclaw-memory-memories") as MemoryMemoriesTestElement;
  element.client = { request } as unknown as GatewayBrowserClient;
  element.connected = true;
  element.connectionPhase = options.connectionPhase ?? "connected";
  element.methodAdvertised = advertised;
  element.wikiSearchAdvertised = options.wikiSearch ?? false;
  element.browseEnabled = options.browse ?? false;
  element.browseListAdvertised = options.browseList ?? false;
  element.personalDetailAdvertised = options.personalDetail ?? true;
  element.wikiGetAdvertised = options.wikiGet ?? false;
  element.organizationGetAdvertised = options.organizationGet ?? false;
  element.agentId = "main";
  document.body.append(element);
  return element;
}

export async function typeQuery(element: MemoryMemoriesTestElement, query: string) {
  await element.updateComplete;
  const input = element.querySelector<HTMLInputElement>("#memory-search-input");
  if (!input) {
    throw new Error("missing memory search input");
  }
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await element.updateComplete;
}

export function submit(element: MemoryMemoriesTestElement) {
  element
    .querySelector("form")
    ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

export const result = {
  path: "memory/people/ada.md",
  startLine: 2,
  endLine: 3,
  score: 0.876,
  snippet: "Ada prefers careful reviews.",
  source: "memory" as const,
};
