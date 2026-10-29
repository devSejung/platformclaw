import {
  a as r,
  b as v,
  c,
  d as m,
  e as z,
  f as g,
  g as x,
  h as f,
  i as s,
  j as h,
} from "./chunks/chunk-K2YLLSIX.js";
var t = r(v(), 1),
  u = r(z(), 1);
var o = r(c(), 1),
  C = new URL("./", location.href).href,
  l = g(new URLSearchParams(location.search).get("lang")),
  e = (n) => x(n, l);
document.documentElement.lang = l;
document.title = e("PlatformClaw \uBAA8\uC158 \uAC00\uC774\uB4DC");
var N = ["chat", "spaces", "clock", "skill", "idea", "share", "doc", "lock"],
  P = () => {
    let [n, d] = (0, t.useState)(null),
      p = (0, t.useRef)(null),
      a = s.find((i) => i.id === n);
    return (
      (0, t.useEffect)(() => {
        n ? p.current?.showModal() : p.current?.close();
      }, [n]),
      (0, o.jsxs)(o.Fragment, {
        children: [
          (0, o.jsxs)("header", {
            className: "gallery-brand",
            children: [
              (0, o.jsx)("img", {
                src: "./brand/platformclaw-mascot.svg",
                alt: e("PlatformClaw \uB9C8\uC2A4\uCF54\uD2B8"),
              }),
              (0, o.jsx)("strong", { children: "PlatformClaw" }),
            ],
          }),
          (0, o.jsxs)("main", {
            children: [
              (0, o.jsxs)("div", {
                className: "gallery-intro",
                children: [
                  (0, o.jsx)("h1", {
                    children: e("\uC791\uC5C5\uC774 \uC774\uC5B4\uC9C0\uB294 \uC21C\uAC04."),
                  }),
                  (0, o.jsx)("p", {
                    children: e(
                      "Jira\xB7Confluence \uACFC\uC81C \uC608\uC81C \xB7 PlatformClaw \uBAA8\uC158 \uAC00\uC774\uB4DC",
                    ),
                  }),
                ],
              }),
              (0, o.jsx)("section", {
                className: "motion-grid",
                children: s.map((i, b) =>
                  (0, o.jsxs)(
                    "button",
                    {
                      className: "motion-card",
                      "aria-label": ""
                        .concat(e(i.title), " \xB7 ")
                        .concat(e("\uBAA8\uC158 \uBCF4\uAE30")),
                      onClick: () => d(i.id),
                      children: [
                        (0, o.jsxs)("div", {
                          className: "motion-thumbnail",
                          children: [
                            (0, o.jsx)("div", {
                              className: "thumbnail-mark",
                              children: (0, o.jsx)(f, { name: N[b], size: 76 }),
                            }),
                            i.id === "memory" &&
                              (0, o.jsxs)("svg", {
                                viewBox: "0 0 300 180",
                                className: "thumbnail-links",
                                children: [
                                  (0, o.jsx)("path", {
                                    d: "M150 90 45 35m105 55 90-45m-90 45-60 70m60-70 100 65",
                                    fill: "none",
                                    stroke: "currentColor",
                                    strokeWidth: "1.2",
                                  }),
                                  [
                                    [45, 35],
                                    [240, 45],
                                    [90, 160],
                                    [250, 155],
                                  ].map(([y, w], k) =>
                                    (0, o.jsx)(
                                      "circle",
                                      { cx: y, cy: w, r: "7", fill: "currentColor" },
                                      k,
                                    ),
                                  ),
                                ],
                              }),
                          ],
                        }),
                        (0, o.jsxs)("div", {
                          className: "motion-card-title",
                          children: [
                            (0, o.jsx)("strong", { children: i.word }),
                            (0, o.jsx)("span", { className: "play-mark", children: "\u2197" }),
                          ],
                        }),
                        (0, o.jsxs)("span", {
                          className: "motion-card-subtitle",
                          children: [e(i.title), " \xB7 ", i.seconds, l === "ko" ? "\uCD08" : "s"],
                        }),
                      ],
                    },
                    i.id,
                  ),
                ),
              }),
            ],
          }),
          (0, o.jsxs)("dialog", {
            "aria-labelledby": "motion-title",
            ref: p,
            className: "motion-dialog",
            onCancel: () => d(null),
            children: [
              (0, o.jsxs)("header", {
                children: [
                  (0, o.jsxs)("div", {
                    children: [
                      (0, o.jsx)("strong", { id: "motion-title", children: a?.word }),
                      (0, o.jsx)("span", { children: a && e(a.description) }),
                    ],
                  }),
                  (0, o.jsx)("button", {
                    "aria-label": e("\uB2EB\uAE30"),
                    onClick: () => d(null),
                    children: "\xD7",
                  }),
                ],
              }),
              a &&
                (0, o.jsx)(
                  m,
                  {
                    component: h,
                    inputProps: { topicId: a.id, assetBase: C, locale: l },
                    durationInFrames: a.seconds * 30,
                    fps: 30,
                    compositionWidth: 1920,
                    compositionHeight: 1080,
                    controls: !0,
                    autoPlay: !0,
                    loop: !1,
                    style: { width: "100%", aspectRatio: "16/9" },
                  },
                  a.id,
                ),
            ],
          }),
        ],
      })
    );
  };
(0, u.createRoot)(document.getElementById("gallery")).render((0, o.jsx)(P, {}));
