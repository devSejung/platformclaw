/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleLitElement } from "../../../test-helpers/lit-settle.ts";
import { isHtmlAttachment } from "./chat-html-attachment.ts";

const SOURCE = "/api/chat/media/outgoing/agent%3Aemployee%3Amain/owned-document/full";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function openPreview(mode: "strict" | "scripts" = "scripts") {
  const element = document.createElement("openclaw-chat-html-attachment");
  element.src = `${SOURCE}?mediaTicket=owned-ticket`;
  element.sourceIdentity = SOURCE;
  element.label = "report.html";
  element.embedSandboxMode = mode;
  document.body.append(element);
  await settleLitElement(element);
  element.querySelector("button")?.click();
  await settleLitElement(element);
  const frame = element.querySelector("iframe");
  if (!frame) {
    throw new Error("expected managed HTML preview iframe");
  }
  return { element, frame, url: new URL(frame.src) };
}

function sendStatus(frame: HTMLIFrameElement, nonce: string, status = "ready", message?: string) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: { type: "openclaw:html-attachment-preview", nonce, status, message },
    }),
  );
}

describe("managed HTML attachment preview", () => {
  it.each([
    ["text/html; charset=utf-8", "report", true],
    ["application/octet-stream", "report.HTM", true],
    ["text/plain", "report.html.txt", false],
  ])("recognizes %s / %s", (mimeType, filename, expected) => {
    expect(isHtmlAttachment(mimeType, filename)).toBe(expected);
  });

  it.each(["scripts", "strict"] as const)(
    "loads only the signed preview contract in %s mode",
    async (mode) => {
      const { element, frame, url } = await openPreview(mode);
      expect(url.pathname).toBe(SOURCE);
      expect(url.searchParams.get("mediaTicket")).toBe("owned-ticket");
      expect(url.searchParams.get("preview")).toBe("1");
      expect(url.searchParams.get("previewMode")).toBe(mode);
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.hasAttribute("hidden")).toBe(false);
      expect(frame.classList.contains("chat-html-attachment__frame--loading")).toBe(true);
      expect(frame.getAttribute("aria-hidden")).toBe("true");
      expect(frame.hasAttribute("inert")).toBe(true);
      expect(element.querySelector('[role="status"]')?.textContent).toContain("Loading");
      const download =
        element.querySelector<HTMLAnchorElement>("a[aria-label]") ?? element.querySelector("a");
      expect(download?.getAttribute("href")).toBe(`${SOURCE}?mediaTicket=owned-ticket`);
      sendStatus(frame, "a-different-request");
      await settleLitElement(element);
      expect(frame.classList.contains("chat-html-attachment__frame--loading")).toBe(true);
      expect(frame.getAttribute("aria-hidden")).toBe("true");
      expect(frame.hasAttribute("inert")).toBe(true);
      sendStatus(frame, url.searchParams.get("previewNonce")!);
      await settleLitElement(element);
      expect(frame.classList.contains("chat-html-attachment__frame--loading")).toBe(false);
      expect(frame.getAttribute("aria-hidden")).toBe("false");
      expect(frame.hasAttribute("inert")).toBe(false);
      expect(element.querySelector('[role="status"]')).toBeNull();
    },
  );

  it("discards old frame status after the artifact owner refreshes its ticket", async () => {
    const { element, frame: oldFrame } = await openPreview();
    element.src = `${SOURCE}?mediaTicket=refreshed-ticket`;
    await settleLitElement(element);
    const frame = element.querySelector("iframe");
    if (!frame) {
      throw new Error("expected refreshed frame");
    }
    expect(frame).not.toBe(oldFrame);
    const nonce = new URL(frame.src).searchParams.get("previewNonce")!;
    sendStatus(oldFrame, nonce);
    await settleLitElement(element);
    expect(frame.classList.contains("chat-html-attachment__frame--loading")).toBe(true);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.hasAttribute("inert")).toBe(true);
    sendStatus(frame, nonce);
    await settleLitElement(element);
    expect(frame.classList.contains("chat-html-attachment__frame--loading")).toBe(false);
    expect(frame.getAttribute("aria-hidden")).toBe("false");
    expect(frame.hasAttribute("inert")).toBe(false);
  });

  it("closes a previous session's preview when the attachment identity changes", async () => {
    const { element, frame } = await openPreview();
    element.sourceIdentity = SOURCE.replace("employee", "different");
    await settleLitElement(element);
    expect(element.querySelector("iframe")).toBeNull();
    sendStatus(frame, new URL(frame.src).searchParams.get("previewNonce")!);
    await settleLitElement(element);
    expect(element.querySelector("iframe")).toBeNull();
  });

  it("shows an authorized preview failure as text and preserves download", async () => {
    const { element, frame, url } = await openPreview();
    sendStatus(frame, url.searchParams.get("previewNonce")!, "error", "Unsupported <img> resource");
    await settleLitElement(element);
    expect(element.querySelector("iframe")).toBeNull();
    expect(element.textContent).toContain("Unsupported <img> resource");
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector("a")?.getAttribute("href")).toContain("mediaTicket=owned-ticket");
  });

  it("reports an expired or missing response instead of leaving a blank frame", async () => {
    vi.useFakeTimers();
    const { element } = await openPreview();
    await vi.advanceTimersByTimeAsync(15_000);
    await settleLitElement(element);
    expect(element.querySelector("iframe")).toBeNull();
    expect(element.textContent).toContain("HTML preview could not load");
    expect(element.querySelector("a")).not.toBeNull();
  });

  it("never embeds an arbitrary URL that lacks the managed preview endpoint", async () => {
    const { element } = await openPreview();
    element.src = "https://untrusted.invalid/report.html";
    await settleLitElement(element);
    expect(element.querySelector("iframe")).toBeNull();
    expect(element.textContent).toContain("HTML preview could not load");
  });
});
