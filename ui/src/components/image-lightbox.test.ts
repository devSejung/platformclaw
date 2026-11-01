/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatImageLightbox } from "../pages/chat/components/chat-image-lightbox.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import type { ImageLightboxImage } from "./image-lightbox.ts";
import "./image-lightbox.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;
let createObjectUrl: ReturnType<typeof vi.fn<(object: Blob | MediaSource) => string>>;
let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
let fetchImage: ReturnType<typeof vi.fn>;

async function renderLightbox(gallery: readonly ImageLightboxImage[] = []) {
  render(
    html`<openclaw-image-lightbox
      src="data:image/png;base64,cG5n"
      title="Generated lobster"
      .gallery=${gallery}
    ></openclaw-image-lightbox>`,
    container,
  );
  const modal = container.querySelector("openclaw-image-lightbox");
  if (!modal) {
    throw new Error("missing image lightbox");
  }
  await modal.updateComplete;
  const dialogAdapter = modal.shadowRoot?.querySelector("openclaw-modal-dialog");
  if (!dialogAdapter) {
    throw new Error("missing modal dialog adapter");
  }
  await getRenderedModalDialog((modal.shadowRoot ?? modal) as unknown as HTMLElement);
  return { modal, dialogAdapter };
}

describe("openclaw-image-lightbox", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    createObjectUrl = vi.fn(() => "blob:lightbox-original");
    revokeObjectUrl = vi.fn();
    fetchImage = vi.fn(async () => ({
      blob: async () => new Blob(["png"], { type: "image/png" }),
    }));
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL(object: Blob | MediaSource): string {
          return createObjectUrl(object);
        }

        static override revokeObjectURL(url: string): void {
          revokeObjectUrl(url);
        }
      },
    );
    vi.stubGlobal("fetch", fetchImage);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    restoreDialogPolyfill();
    vi.unstubAllGlobals();
  });

  it("renders a labelled large image with original and close actions", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;

    expect(root?.querySelector<HTMLImageElement>("img")?.alt).toBe("Generated lobster");
    expect(root?.querySelector<HTMLImageElement>("img")?.src).toBe("data:image/png;base64,cG5n");
    await vi.waitFor(() =>
      expect(root?.querySelector<HTMLAnchorElement>("a")?.href).toBe("blob:lightbox-original"),
    );
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(root?.querySelector<HTMLButtonElement>("button")?.hasAttribute("autofocus")).toBe(true);
  });

  it("accepts parameters on safe raster MIME types", async () => {
    fetchImage.mockResolvedValueOnce({
      blob: async () => new Blob(["png"], { type: "image/png;charset=utf-8" }),
    });
    render(
      html`<openclaw-image-lightbox
        src="data:image/png;charset=utf-8;base64,cG5n"
        title="Generated lobster"
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
        "blob:lightbox-original",
      ),
    );
  });

  it("releases and recreates the original-image URL across reconnection", async () => {
    const { modal } = await renderLightbox();
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));

    modal.remove();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:lightbox-original");

    container.append(modal);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(2));
  });

  it("omits the original action for active data image formats", async () => {
    render(
      html`<openclaw-image-lightbox
        src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>"
        title="Untrusted SVG"
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    expect(modal.shadowRoot?.querySelector(".open-original")).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("keeps Tab focus within the lightbox actions", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;
    await vi.waitFor(() =>
      expect(root?.querySelector<HTMLAnchorElement>(".open-original")).toBeTruthy(),
    );
    const openOriginal = root?.querySelector<HTMLAnchorElement>(".open-original");
    const stage = root?.querySelector<HTMLDivElement>(".stage");
    stage?.focus();

    stage?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root?.activeElement).toBe(openOriginal);

    openOriginal?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(root?.activeElement).toBe(stage);
  });

  it("bounds zoom and resets with controls, wheel, and keyboard", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;
    const zoomIn = root?.querySelector<HTMLButtonElement>(".zoom-in");
    const zoomOut = root?.querySelector<HTMLButtonElement>(".zoom-out");
    const stage = root?.querySelector<HTMLDivElement>(".stage");
    expect(zoomOut?.disabled).toBe(true);
    zoomIn?.click();
    await modal.updateComplete;
    expect(root?.querySelector(".zoom-level")?.textContent?.trim()).toBe("125%");
    for (let index = 0; index < 20; index += 1) {
      zoomIn?.click();
      await modal.updateComplete;
    }
    expect(root?.querySelector(".zoom-level")?.textContent?.trim()).toBe("500%");
    expect(zoomIn?.disabled).toBe(true);
    stage?.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    await modal.updateComplete;
    expect(root?.querySelector(".zoom-level")?.textContent?.trim()).toBe("100%");
    stage?.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    await modal.updateComplete;
    expect(root?.querySelector(".zoom-level")?.textContent?.trim()).toBe("125%");
    root?.querySelector<HTMLButtonElement>(".reset-zoom")?.click();
    await modal.updateComplete;
    expect(zoomOut?.disabled).toBe(true);
  });

  it("pans a zoomed image within its viewport and releases the pointer on reset", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;
    const stage = root?.querySelector<HTMLDivElement>(".stage");
    const image = root?.querySelector<HTMLImageElement>(".image");
    if (!stage || !image) {
      throw new Error("missing image viewport");
    }
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    stage.style.padding = "0px";
    Object.defineProperties(stage, {
      clientWidth: { value: 400 },
      clientHeight: { value: 300 },
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: releasePointerCapture },
    });
    Object.defineProperties(image, {
      clientWidth: { value: 400 },
      clientHeight: { value: 300 },
    });
    stage.dispatchEvent(new Event("dblclick"));
    await modal.updateComplete;
    stage.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 7, clientX: 10, clientY: 20, button: 0 }),
    );
    stage.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 7, clientX: 900, clientY: 900 }),
    );
    await modal.updateComplete;
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(image.style.transform).toBe("translate(200px, 150px) scale(2)");
    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await modal.updateComplete;
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(stage.hasAttribute("data-dragging")).toBe(false);
  });

  it("navigates a gallery and resets zoom for each selected image", async () => {
    const { modal } = await renderLightbox([
      { src: "data:image/png;base64,cG5n", title: "Generated lobster" },
      { src: "https://example.com/second.png", title: "Second image" },
    ]);
    const root = modal.shadowRoot;
    root?.querySelector<HTMLButtonElement>(".zoom-in")?.click();
    root?.querySelector<HTMLButtonElement>(".next")?.click();
    await modal.updateComplete;
    await modal.updateComplete;
    expect(root?.querySelector<HTMLImageElement>(".image")?.alt).toBe("Second image");
    expect(root?.querySelector(".position")?.textContent?.trim()).toBe("2 / 2");
    expect(root?.querySelector(".zoom-level")?.textContent?.trim()).toBe("100%");
    expect(root?.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
      "https://example.com/second.png",
    );
    expect(root?.querySelector<HTMLButtonElement>(".next")?.disabled).toBe(true);
    root
      ?.querySelector(".stage")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await modal.updateComplete;
    expect(root?.querySelector<HTMLImageElement>(".image")?.alt).toBe("Generated lobster");
    expect(root?.querySelector<HTMLButtonElement>(".previous")?.disabled).toBe(true);
  });

  it("preserves zoom when the chat rerenders an unchanged single-image modal", async () => {
    const item = { src: "https://example.com/image.png", title: "Image" };
    const close = vi.fn();
    render(renderChatImageLightbox(item, close), container);
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;
    modal.shadowRoot?.querySelector<HTMLButtonElement>(".zoom-in")?.click();
    await modal.updateComplete;
    render(renderChatImageLightbox(item, close), container);
    await modal.updateComplete;
    expect(modal.shadowRoot?.querySelector(".zoom-level")?.textContent?.trim()).toBe("125%");
  });

  it("opens the clicked gallery item when multiple images share the same URL", async () => {
    const { modal } = await renderLightbox([
      { src: "data:image/png;base64,cG5n", title: "Another image" },
      { src: "data:image/png;base64,cG5n", title: "Generated lobster" },
    ]);
    expect(modal.shadowRoot?.querySelector(".position")?.textContent?.trim()).toBe("2 / 2");
  });

  it("emits one close event for the close button and modal cancellation", async () => {
    const { modal, dialogAdapter } = await renderLightbox();
    let closes = 0;
    modal.addEventListener("image-lightbox-close", () => {
      closes += 1;
    });

    modal.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
    expect(closes).toBe(1);

    dialogAdapter.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    expect(closes).toBe(2);
  });
});
