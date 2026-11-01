/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import {
  cacheManagedImageBlobUrl,
  readManagedImageBlobUrl,
  releaseChatMediaResourceSubscriber,
} from "./chat-message-media.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image gallery ownership", () => {
  it("keeps every gallery Blob alive until the modal owner releases it", async () => {
    const NativeUrl = URL;
    const revoked = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override revokeObjectURL = revoked;
      },
    );
    const sources = [0, 1].map(
      () => `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
    );
    const keys = sources.map((source) => `${source}::::`);
    const urls = sources.map((source) => {
      const url = `blob:gallery-${crypto.randomUUID()}`;
      cacheManagedImageBlobUrl(`${source}::::`, url);
      return url;
    });
    const images = sources.map((source, index) => ({
      url: source,
      displayUrl: source,
      alt: `Image ${index + 1}`,
    }));
    const container = document.createElement("div");
    const refresh = vi.fn();
    let opened: ImageLightboxItem | undefined;
    try {
      render(
        renderMessageImages(images, {
          onOpenImage: (item) => {
            opened = item;
          },
          onRequestUpdate: refresh,
        }),
        container,
      );
      await vi.waitFor(() =>
        expect(container.querySelectorAll(".chat-message-image-button")).toHaveLength(2),
      );
      container.querySelector<HTMLButtonElement>(".chat-message-image-button")?.click();
      expect(opened?.gallery).toEqual(
        urls.map((src, index) => ({ src, title: `Image ${index + 1}` })),
      );

      render(nothing, container);
      releaseChatMediaResourceSubscriber(refresh);
      for (let index = 0; index < 70; index += 1) {
        cacheManagedImageBlobUrl(`replacement-${crypto.randomUUID()}`, `blob:replacement-${index}`);
      }
      keys.forEach((key, index) => expect(readManagedImageBlobUrl(key)).toBe(urls[index]));
      urls.forEach((url) => expect(revoked).not.toHaveBeenCalledWith(url));

      opened?.release?.();
      for (let index = 0; index < 70; index += 1) {
        cacheManagedImageBlobUrl(`after-close-${crypto.randomUUID()}`, `blob:after-close-${index}`);
      }
      urls.forEach((url) => expect(revoked).toHaveBeenCalledWith(url));
    } finally {
      opened?.release?.();
      render(nothing, container);
      releaseChatMediaResourceSubscriber(refresh);
    }
  });

  it("does not pass unsafe gallery URLs to the viewer", () => {
    const onOpen = vi.fn();
    openResolvedImage(onOpen, "https://example.com/image.png", "Image", undefined, undefined, [
      { src: "https://example.com/image.png", title: "Image" },
      { src: "javascript:alert(1)", title: "Unsafe" },
    ]);
    expect(onOpen).toHaveBeenCalledWith({ src: "https://example.com/image.png", title: "Image" });
  });
});
