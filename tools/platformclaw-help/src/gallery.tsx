import { Player } from "@remotion/player";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HelpClip } from "./HelpClip";
import { motionText, resolveMotionLocale } from "./i18n";
import { Glyph } from "./ProductUI";
import "./gallery.css";
import { topics, type TopicId } from "./topics";

const assetBase = new URL("./", location.href).href;
const locale = resolveMotionLocale(new URLSearchParams(location.search).get("lang"));
const textFor = (text: string) => motionText(text, locale);
document.documentElement.lang = locale;
document.title = textFor("PlatformClaw 모션 가이드");
const marks = ["chat", "spaces", "clock", "skill", "idea", "share", "doc", "lock"] as const;
const Gallery = () => {
  const [selected, setSelected] = useState<TopicId | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const topic = topics.find((t) => t.id === selected);
  useEffect(() => {
    if (selected) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);
  return (
    <>
      <header className="gallery-brand">
        <img src="./brand/platformclaw-mascot.svg" alt={textFor("PlatformClaw 마스코트")} />
        <strong>PlatformClaw</strong>
      </header>
      <main>
        <div className="gallery-intro">
          <h1>{textFor("작업이 이어지는 순간.")}</h1>
          <p>{textFor("Jira·Confluence 과제 예제 · PlatformClaw 모션 가이드")}</p>
        </div>
        <section className="motion-grid">
          {topics.map((item, i) => (
            <button
              className="motion-card"
              key={item.id}
              aria-label={`${textFor(item.title)} · ${textFor("모션 보기")}`}
              onClick={() => setSelected(item.id)}
            >
              <div className="motion-thumbnail">
                <div className="thumbnail-mark">
                  <Glyph name={marks[i]} size={76} />
                </div>
                {item.id === "memory" && (
                  <svg viewBox="0 0 300 180" className="thumbnail-links">
                    <path
                      d="M150 90 45 35m105 55 90-45m-90 45-60 70m60-70 100 65"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                    {[
                      [45, 35],
                      [240, 45],
                      [90, 160],
                      [250, 155],
                    ].map(([x, y], n) => (
                      <circle key={n} cx={x} cy={y} r="7" fill="currentColor" />
                    ))}
                  </svg>
                )}
              </div>
              <div className="motion-card-title">
                <strong>{item.word}</strong>
                <span className="play-mark">↗</span>
              </div>
              <span className="motion-card-subtitle">
                {textFor(item.title)} · {item.seconds}
                {locale === "ko" ? "초" : "s"}
              </span>
            </button>
          ))}
        </section>
      </main>
      <dialog
        aria-labelledby="motion-title"
        ref={dialog}
        className="motion-dialog"
        onCancel={() => setSelected(null)}
      >
        <header>
          <div>
            <strong id="motion-title">{topic?.word}</strong>
            <span>{topic && textFor(topic.description)}</span>
          </div>
          <button aria-label={textFor("닫기")} onClick={() => setSelected(null)}>
            ×
          </button>
        </header>
        {topic && (
          <Player
            key={topic.id}
            component={HelpClip}
            inputProps={{ topicId: topic.id, assetBase, locale }}
            durationInFrames={topic.seconds * 30}
            fps={30}
            compositionWidth={1920}
            compositionHeight={1080}
            controls
            autoPlay
            loop={false}
            style={{ width: "100%", aspectRatio: "16/9" }}
          />
        )}
      </dialog>
    </>
  );
};
createRoot(document.getElementById("gallery")!).render(<Gallery />);
