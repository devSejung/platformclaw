import { html, nothing } from "lit";
import type { RouteId } from "../app-route-paths.ts";
import { resolveControlUiBasePath } from "../app/browser.ts";
import { i18n } from "../i18n/index.ts";

const topics: Partial<Record<RouteId, string>> = {
  chat: "chat",
  dashboard: "chat",
  "new-session": "chat",
  spaces: "spaces",
  cron: "cron",
  automation: "cron",
  skills: "skills",
  "skill-workshop": "skill-workshop",
  "skill-hub": "skill-hub",
  memory: "memory",
  credentials: "credentials",
};

export function helpVideoTopic(routeId: RouteId) {
  return topics[routeId] ?? null;
}

/** Mount only while the help dialog is open; removal ends playback. */
export function renderPageHelpVideo(routeId: RouteId, title: string) {
  const topic = helpVideoTopic(routeId);
  if (!topic) {
    return nothing;
  }
  const base = resolveControlUiBasePath(location.pathname);
  const lang = i18n.getLocale() === "ko" ? "ko" : "en";
  return html`<iframe
    data-help-video=${topic}
    title=${title}
    src=${`${base}/help-video/player.html?topic=${encodeURIComponent(topic)}&lang=${lang}`}
    allow="autoplay; fullscreen"
    allowfullscreen
    style="display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:10px"
  ></iframe>`;
}
