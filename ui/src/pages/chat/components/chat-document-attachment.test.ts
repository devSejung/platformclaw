/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleLitElement } from "../../../test-helpers/lit-settle.ts";
import { documentPreviewKind } from "./chat-document-attachment.ts";

const SOURCE = "/api/chat/media/outgoing/agent%3Aemployee%3Amain/owned-file/full";
const PDF = "%PDF-1.7\nowned document";
const fetchMock = vi.fn<typeof fetch>();
const revoke = vi.fn();
const create = vi.fn(() => "blob:http://localhost/owned-pdf");

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    },
  );
  fetchMock.mockResolvedValue(
    new Response(PDF, { headers: { "Content-Type": "application/pdf" } }),
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
  await vi.waitFor(() => expect(element.querySelector("iframe")).not.toBeNull());
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

  it("reads an authorized PDF only on opening, keeping the original download", async () => {
    const element = await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    await open(element);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url instanceof URL ? url.href : url).toContain(`${SOURCE}?mediaTicket=owned-ticket`);
    expect(options).toMatchObject({ credentials: "same-origin", redirect: "error" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "application/pdf" }));
    expect(element.querySelector("iframe")?.src).toBe("blob:http://localhost/owned-pdf");
    expect(element.querySelector("a")?.getAttribute("href")).toBe(
      `${SOURCE}?mediaTicket=owned-ticket`,
    );
    element.querySelector("button")?.click();
    await settleLitElement(element);
    expect(element.querySelector("iframe")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/owned-pdf");
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
    expect(create).not.toHaveBeenCalled();
    expect(element.querySelector("iframe")).toBeNull();
  });

  it("retires already displayed bytes before accepting a replacement grant", async () => {
    const element = await mount();
    await open(element);
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 404 }));
    element.src = `${SOURCE}?mediaTicket=replaced-ticket`;
    await vi.waitFor(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/owned-pdf");
    expect(element.querySelector("iframe")).toBeNull();
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
    await vi.waitFor(() => expect(element.querySelector("iframe")).not.toBeNull());
    finishCancel?.();
    await settleLitElement(element);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector("iframe")).not.toBeNull();
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
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["text/html", PDF],
    ["application/pdf", "<script>parent.document.body.remove()</script>"],
  ])("refuses an invalid PDF response %s", async (type, body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": type } }));
    const element = await mount();
    element.querySelector("button")?.click();
    await vi.waitFor(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());
    expect(create).not.toHaveBeenCalled();
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
    expect(create).not.toHaveBeenCalled();
  });

  it("shows converter enablement guidance and retains the original download", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const element = await mount("application/vnd.ms-powerpoint", "slides.ppt");
    element.querySelector("button")?.click();
    await vi.waitFor(() => expect(element.textContent).toContain("LibreOffice Impress"));
    expect(element.querySelector("iframe")).toBeNull();
    expect(element.querySelector("a")).not.toBeNull();
  });

  it("releases display bytes when its element is removed", async () => {
    const element = await mount();
    await open(element);
    element.remove();
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/owned-pdf");
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
    expect(create).not.toHaveBeenCalled();
  });
});
