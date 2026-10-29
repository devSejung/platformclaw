import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { Glyph, Mascot, Composer, colors } from "./ProductUI";
import { typedPrefix } from "./typing";

export const CredentialsFilm: React.FC<{ assetBase?: string }> = ({ assetBase }) => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const enter = clamp(reveal(frame, 1.4, fps));
  const configure = beat(t, 3.6, 4.6);
  const save = beat(t, 7.3, 8.3);
  const back = beat(t, 9.1, 10.2);
  const out = 1 - beat(t, 11.7, 12.3);
  return (
    <section
      data-motion="chat-request-private-credential-return"
      style={{
        position: "absolute",
        inset: 0,
        opacity: out,
        wordBreak: "keep-all",
      }}
    >
      <article
        className="product-fragment"
        data-credential-request
        style={{
          position: "absolute",
          left: 400,
          top: 530,
          translate: "-50% -50%",
          width: 470,
          padding: 36,
          opacity: enter,
          scale: mix(0.85, 1, enter),
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            fontSize: 22,
            color: colors.teal,
          }}
        >
          <Glyph name="chat" size={26} />
          {textFor("챗 · Jira")}
        </div>
        <h3 style={{ fontSize: 33 }}>{textFor("ULY-142 조회")}</h3>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 28,
            fontSize: 24,
          }}
        >
          <Mascot size={40} assetBase={assetBase} />
          <Glyph name="key" size={28} />
          JIRA_API_TOKEN
        </div>
        <div
          style={{
            marginTop: 28,
            display: "inline-flex",
            alignItems: "center",
            gap: 14,
            padding: "15px 22px",
            borderRadius: 10,
            color: "white",
            background: colors.teal,
            fontSize: 23,
            opacity: 1 - back,
          }}
        >
          <Glyph name="key" size={24} />
          {textFor("키 등록하기")}
        </div>
        <div
          style={{
            fontSize: 21,
            color: colors.teal,
            marginTop: 28,
            opacity: back,
          }}
        >
          {textFor("챗으로 돌아가기 ↗")}
        </div>
      </article>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <path
          d="M635 530H850"
          stroke={colors.teal}
          strokeWidth="2"
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - configure}
          opacity={configure * (1 - back) * 0.5}
        />
        <path
          d="M850 640Q750 760 635 640"
          stroke={colors.teal}
          fill="none"
          strokeWidth="2"
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - back}
          opacity={back * 0.5}
        />
      </svg>
      <article
        className="product-fragment"
        data-private-credential-form
        style={{
          position: "absolute",
          left: 1190,
          top: 530,
          translate: `-50% ${mix(-30, -50, configure)}%`,
          width: 660,
          padding: 42,
          opacity: configure * (1 - back),
          scale: mix(0.9, 1, configure),
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 13,
            color: colors.teal,
            fontSize: 25,
          }}
        >
          <Glyph name="lock" size={28} />
          {textFor("설정 · 내 인증정보")}
        </div>
        <div style={{ fontSize: 24, marginTop: 35 }}>JIRA_API_TOKEN</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "23px 25px",
            border: `1px solid ${colors.line}`,
            borderRadius: 13,
            marginTop: 20,
            height: 42,
            fontSize: 34,
            letterSpacing: 7,
          }}
        >
          <span data-secret-placeholder style={{ flex: 1 }}>
            {typedPrefix("••••••••••••", frame, 4.9 * fps, 6.5 * fps)}
          </span>
          <Glyph name="lock" size={27} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 30,
            fontSize: 23,
          }}
        >
          <span
            style={{
              padding: "13px 28px",
              borderRadius: 10,
              background: colors.teal,
              color: "white",
              scale: 1 + Math.sin(save * Math.PI) * 0.08,
            }}
          >
            {textFor("저장")}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: colors.teal,
              opacity: save,
            }}
          >
            <Glyph name="lock" size={24} />
            {textFor("등록됨")}
          </span>
        </div>
      </article>
      <div
        data-credential-return-composer
        style={{
          position: "absolute",
          left: 1170,
          top: 550,
          translate: `-50% ${mix(-35, -50, back)}%`,
          opacity: back,
          scale: mix(0.9, 1, back),
        }}
      >
        <div
          className="product-fragment"
          style={{ padding: 35, width: 700, boxSizing: "border-box" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              fontSize: 26,
              color: colors.teal,
            }}
          >
            <Glyph name="chat" size={28} />
            {textFor("챗 · Ulysses")}
          </div>
          <Composer
            text="이어서 점검해줘"
            style={{
              width: "100%",
              fontSize: 28,
              marginTop: 30,
              boxShadow: "none",
            }}
          />
        </div>
      </div>
    </section>
  );
};
