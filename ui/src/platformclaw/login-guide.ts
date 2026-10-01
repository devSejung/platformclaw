/** A same-origin media URL is injected by the control process, not compiled into the login bundle. */
export function installPlatformClawLoginGuide(root: ParentNode): void {
  const configuredUrl = root.querySelector<HTMLMetaElement>(
    'meta[name="platformclaw-guide-video-url"]',
  )?.content;
  if (!configuredUrl?.trim()) {
    return;
  }
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return;
  }
  const documentOrigin =
    root instanceof Document ? root.location.origin : globalThis.location.origin;
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.origin !== documentOrigin
  ) {
    return;
  }
  const section = root.querySelector<HTMLElement>("[data-login-guide]");
  const button = root.querySelector<HTMLButtonElement>("[data-login-guide-open]");
  const dialog = root.querySelector<HTMLDialogElement>("[data-login-guide-dialog]");
  const close = root.querySelector<HTMLButtonElement>("[data-login-guide-close]");
  const video = root.querySelector<HTMLVideoElement>("[data-login-guide-video]");
  const error = root.querySelector<HTMLElement>("[data-login-guide-error]");
  const link = root.querySelector<HTMLAnchorElement>("[data-login-guide-link]");
  if (!section || !button || !dialog || !close || !video || !error || !link) {
    return;
  }
  link.href = url.href;
  button.addEventListener("click", () => {
    error.hidden = true;
    // Do not contact the same-origin media proxy until the user explicitly opens the guide.
    video.preload = "metadata";
    video.src = url.href;
    dialog.showModal();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    // Esc and the close button both stop playback and release the media request.
    video.pause();
    video.removeAttribute("src");
    video.load();
    button.focus({ preventScroll: true });
  });
  video.addEventListener("error", () => {
    if (dialog.open && video.hasAttribute("src")) {
      error.hidden = false;
    }
  });
  section.hidden = false;
}
