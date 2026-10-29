import {
  a as e,
  c as i,
  d as r,
  e as u,
  f as c,
  g as a,
  i as l,
  j as s,
} from "./chunks/chunk-K2YLLSIX.js";
var m = e(u(), 1);
var f = e(i(), 1),
  d = new URLSearchParams(location.search),
  n = c(d.get("lang"));
document.documentElement.lang = n;
var t = l.find((o) => o.id === d.get("topic")),
  p = document.getElementById("player");
document.addEventListener(
  "keydown",
  (o) => {
    o.key === "Escape" &&
      !document.fullscreenElement &&
      window.parent !== window &&
      window.parent.postMessage({ type: "platformclaw-help-close" }, location.origin);
  },
  !0,
);
t
  ? (0, m.createRoot)(p).render(
      (0, f.jsx)(r, {
        component: s,
        inputProps: { topicId: t.id, locale: n, assetBase: new URL("./", location.href).href },
        durationInFrames: t.seconds * 30,
        fps: 30,
        compositionWidth: 1920,
        compositionHeight: 1080,
        controls: !0,
        loop: !1,
        autoPlay: !0,
        style: { width: "100%", aspectRatio: "16/9", display: "block" },
      }),
    )
  : (p.textContent = a(
      "\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uAC00\uC774\uB4DC\uC785\uB2C8\uB2E4.",
      n,
    ));
