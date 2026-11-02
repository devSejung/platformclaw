/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleLitElement } from "../../../test-helpers/lit-settle.ts";
import { documentPreviewKind } from "./chat-document-attachment.ts";

const SOURCE = "/api/chat/media/outgoing/agent%3Aemployee%3Amain/owned-file/full";
const PDF = "%PDF-1.7\nowned document";
const fetchMock = vi.fn<typeof fetch>();
const visibilityObservers: DocumentVisibilityObserver[] = [];

class DocumentVisibilityObserver {
  target: Element | undefined;

  constructor(
    private readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  ) {
    visibilityObservers.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  disconnect(): void {
    this.target = undefined;
  }

  setVisible(isIntersecting: boolean): void {
    if (this.target) {
      this.callback([{ target: this.target, isIntersecting }]);
    }
  }
}

// Authorization/fetch ownership is tested here; renderer behavior has its own browser proof.
vi.mock("../../../components/document-viewer.ts", () => ({}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", DocumentVisibilityObserver);
  visibilityObservers.length = 0;
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(PDF, { headers: { "Content-Type": "application/pdf" } })),
  );
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function mount(mimeType = "application/pdf", label = "report.pdf") {
  const element = document.createElement("openclaw-chat-document-attachment");
  element.src = `${SOURCE}?mediaTicket=owned-ticket`;
  element.sourceIdentity = SOURCE;
  element.mimeType = mimeType;
  element.label = label;
  document.body.append(element);
  await settleLitElement(element);
  return element;
}

async function open(element: HTMLElement) {
  element.querySelector("button")?.click();
  await vi.waitFor(() => expect(element.querySelector("openclaw-document-viewer")).not.toBeNull());
}

function setVisible(element: HTMLElement, visible: boolean): void {
  const card = element.querySelector(".chat-document-attachment");
  const observer = visibilityObservers.find((candidate) => candidate.target === card);
  if (!observer) {
    throw new Error("document card visibility was not observed");
  }
  observer.setVisible(visible);
}

describe("managed PDF and PowerPoint preview", () => {
  it.each([
    ["application/pdf; charset=binary", "report", "pdf"],
    ["application/vnd.ms-powerpoint", "slides", "powerpoint"],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "slides",
      "powerpoint",
    ],
    ["application/octet-stream", "slides.PPTX", "powerpoint"],
    [undefined, "report.pdf", "pdf"],
    ["text/html", "fake.pdf", undefined],
    ["application/zip", "slides.pptx", undefined],
  ])("classifies %s / %s without overriding an explicit MIME", (mime, name, expected) => {
    expect(documentPreviewKind(mime, name)).toBe(expected);
  });

  it("keeps offscreen reads manual and preserves the original download", async () => {
    const element = await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    await open(element);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url instanceof URL ? url.href : url).toContain(`${SOURCE}?mediaTicket=owned-ticket`);
    expect(options).toMatchObject({ credentials: "same-origin", redirect: "error" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const viewer = element.querySelector("openclaw-document-viewer");
    expect(viewer?.bytes).toEqual(new TextEncoder().encode(PDF).buffer);
    expect(viewer?.documentTitle).toBe("report.pdf");
    expect(element.querySelector("a")?.getAttribute("href")).toBe(
      `${SOURCE}?mediaTicket=owned-ticket`,
    );
    element.querySelector("button")?.click();
    await settleLitElement(element);
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
  });

  it.each([
    ["application/pdf", "report.pdf", "page"],
    ["application/vnd.ms-powerpoint", "slides.ppt", "slide"],
  ])("forwards the owning request callback and %s page unit", async (mime, label, pageUnit) => {
    const element = await mount(mime, label);
    const handler = vi.fn(async () => ({ admitted: true as const }));
    element.requestChanges = handler;
    await open(element);
    const viewer = element.querySelector("openclaw-document-viewer");
    expect(viewer?.requestChanges).toBe(handler);
    expect(viewer?.pageUnit).toBe(pageUnit);
  });

  it.each([
    ["application/pdf", "report.pdf"],
    ["application/vnd.ms-powerpoint", "slides.ppt"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "slides.pptx"],
  ])("automatically previews visible %s without expanding", async (mime, label) => {
    const element = await mount(mime, label);
    setVisible(element, false);
    await settleLitElement(element);
    expect(fetchMock).not.toHaveBeenCalled();
    setVisible(element, true);
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-document-viewer")).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(element.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(element.querySelector("dialog")).toBeNull();
    setVisible(element, true);
    await settleLitElement(element);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a manually closed source closed through visibility and grant changes", async () => {
    const element = await mount();
    setVisible(element, true);
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-document-viewer")).not.toBeNull(),
    );
    element.querySelector("button")?.click();
    await settleLitElement(element);
    setVisible(element, false);
    element.src = `${SOURCE}?mediaTicket=renewed-ticket`;
    element.mimeType = "application/pdf; charset=binary";
    await settleLitElement(element);
    setVisible(element, true);
    await settleLitElement(element);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
    element.remove();
    document.body.append(element);
    await settleLitElement(element);
    setVisible(element, true);
    await settleLitElement(element);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await open(element);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows a different visible source to auto-open after manual Close", async () => {
    const element = await mount();
    setVisible(element, true);
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-document-viewer")).not.toBeNull(),
    );
    element.querySelector("button")?.click();
    await settleLitElement(element);
    const replacement = SOURCE.replace("owned-file", "replacement-file");
    element.sourceIdentity = replacement;
    element.src = `${replacement}?mediaTicket=new-owner-ticket`;
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-document-viewer")).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains manual opening when visibility observation is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const element = await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    await open(element);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests PowerPoint conversion on the same signed snapshot route", async () => {
    const element = await mount("application/vnd.ms-powerpoint", "slides.ppt");
    await open(element);
    const input = fetchMock.mock.calls[0]![0];
    if (!(input instanceof URL)) {
      throw new Error("expected a resolved same-origin document URL");
    }
    const url = input;
    expect(url.searchParams.get("preview")).toBe("1");
    expect(url.searchParams.get("mediaTicket")).toBe("owned-ticket");
    expect(element.querySelector("a")?.getAttribute("href")).not.toContain("preview=");
  });

  it("aborts an old owner read and never publishes its late result", async () => {
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const element = await mount();
    element.querySelector("button")?.click();
    await settleLitElement(element);
    const signal = fetchMock.mock.calls[0]![1]?.signal;
    element.sourceIdentity = SOURCE.replace("employee", "other-user");
    await settleLitElement(element);
    expect(signal?.aborted).toBe(true);
    finish?.(new Response(PDF, { headers: { "Content-Type": "application/pdf" } }));
    await settleLitElement(element);
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
  });

  it("retires already displayed bytes before accepting a replacement grant", async () => {
    const element = await mount();
    await open(element);
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 404 }));
    element.src = `${SOURCE}?mediaTicket=replaced-ticket`;
    await vi.waitFor(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());

    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
  });

  it("does not let a cancelled old error hide a newly authorized preview", async () => {
    let finishCancel: (() => void) | undefined;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 404 }));
    const element = await mount();
    element.querySelector("button")?.click();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    element.src = `${SOURCE}?mediaTicket=newly-authorized-ticket`;
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-document-viewer")).not.toBeNull(),
    );
    finishCancel?.();
    await settleLitElement(element);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector("openclaw-document-viewer")).not.toBeNull();
  });

  it.each([
    ["https://external.invalid/api/chat/media/outgoing/session/file/full", "application/pdf"],
    ["/arbitrary.pdf", "application/pdf"],
    ["//external.invalid/report.pdf", "application/pdf"],
  ])("never fetches an unowned preview URL %s", async (source, mime) => {
    const element = await mount(mime);
    element.src = source;
    await settleLitElement(element);
    element.querySelector("button")?.click();
    await vi.waitFor(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
  });

  it.each([
    ["text/html", PDF],
    ["application/pdf", "<script>parent.document.body.remove()</script>"],
  ])("refuses an invalid PDF response %s", async (type, body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": type } }));
    const element = await mount();
    element.querySelector("button")?.click();
    await vi.waitFor(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
    expect(element.querySelector("a")).not.toBeNull();
  });

  it("bounds the actual stream even without trustworthy size metadata", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      cancel,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { "Content-Type": "application/pdf" } }),
    );
    const element = await mount();
    element.querySelector("button")?.click();
    await vi.waitFor(() => expect(element.textContent).toContain("16 MiB"));
    expect(cancel).toHaveBeenCalled();
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
  });

  it("shows a failed automatic conversion and retains the original download without retries", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const element = await mount("application/vnd.ms-powerpoint", "slides.ppt");
    setVisible(element, true);
    await vi.waitFor(() => expect(element.textContent).toContain("LibreOffice Impress"));
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
    expect(element.querySelector("a")).not.toBeNull();
    setVisible(element, false);
    setVisible(element, true);
    await settleLitElement(element);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an authorized read when its element is removed", async () => {
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const element = await mount();
    setVisible(element, true);
    await settleLitElement(element);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    element.remove();
    expect(signal?.aborted).toBe(true);
    expect(visibilityObservers.every((observer) => observer.target === undefined)).toBe(true);
    finish?.(new Response(PDF, { headers: { "Content-Type": "application/pdf" } }));
    await settleLitElement(element);
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
  });

  it("aborts a stalled preview and leaves an actionable download outcome", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("private transport detail")),
          );
        }),
    );
    const element = await mount();
    element.querySelector("button")?.click();
    await settleLitElement(element);
    await vi.advanceTimersByTimeAsync(30_000);
    await settleLitElement(element);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("Close and reopen");
    expect(element.textContent).not.toContain("private transport detail");
    expect(element.querySelector("a")).not.toBeNull();
    expect(element.querySelector("openclaw-document-viewer")).toBeNull();
  });
});
