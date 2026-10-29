import { Player } from "@remotion/player";
import React from "react";
import { createRoot } from "react-dom/client";
import { HelpClip } from "./HelpClip";
import { motionText, resolveMotionLocale } from "./i18n";
import { topics } from "./topics";
const query = new URLSearchParams(location.search);
const locale = resolveMotionLocale(query.get("lang"));
document.documentElement.lang = locale;
const topic = topics.find((t) => t.id === query.get("topic"));
const mount = document.getElementById("player")!;
// Keyboard events in a frame do not reach the product's help dialog.
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && !document.fullscreenElement && window.parent !== window) {
      window.parent.postMessage({ type: "platformclaw-help-close" }, location.origin);
    }
  },
  true,
);
if (!topic) {
  mount.textContent = motionText("지원하지 않는 가이드입니다.", locale);
} else {
  createRoot(mount).render(
    <Player
      component={HelpClip}
      inputProps={{
        topicId: topic.id,
        locale,
        assetBase: new URL("./", location.href).href,
      }}
      durationInFrames={topic.seconds * 30}
      fps={30}
      compositionWidth={1920}
      compositionHeight={1080}
      controls
      loop={false}
      autoPlay
      style={{ width: "100%", aspectRatio: "16/9", display: "block" }}
    />,
  );
}
