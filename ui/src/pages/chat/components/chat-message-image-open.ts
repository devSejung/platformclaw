import type { ImageLightboxImage, ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";

export function openResolvedImage(
  onOpenImage: ((item: ImageLightboxItem, requestVersion?: number) => void) | undefined,
  src: string,
  title: string,
  release?: () => void,
  requestVersion?: number,
  gallery?: readonly ImageLightboxImage[],
) {
  const safeSrc = resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
  if (!safeSrc) {
    release?.();
    return;
  }
  if (onOpenImage) {
    const safeGallery = gallery?.flatMap((image) => {
      const imageSrc = resolveSafeExternalUrl(image.src, window.location.href, {
        allowDataImage: true,
      });
      return imageSrc ? [{ src: imageSrc, title: image.title }] : [];
    });
    const item: ImageLightboxItem = {
      src: safeSrc,
      title,
      ...(release ? { release } : {}),
      ...(safeGallery && safeGallery.length > 1 ? { gallery: safeGallery } : {}),
    };
    if (requestVersion === undefined) {
      onOpenImage(item);
    } else {
      onOpenImage(item, requestVersion);
    }
    return;
  }
  release?.();
  openExternalUrlSafe(safeSrc, { allowDataImage: true });
}
