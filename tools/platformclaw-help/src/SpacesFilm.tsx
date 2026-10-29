import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { spaceExample } from "./demo-content";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { Glyph, Mascot, Person, colors } from "./ProductUI";

export const SpacesFilm: React.FC<{ assetBase?: string }> = ({ assetBase }) => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const enter = clamp(reveal(frame, 1.4, fps));
  const share = beat(t, 7.5, 8.7);
  const agent = beat(t, 8.5, 9.5);
  const follow = beat(t, 10.4, 11.3);
  const answer = beat(t, 12, 13.1);
  const out = 1 - beat(t, durationInFrames / fps - 2.3, durationInFrames / fps - 1.7);
  return (
    <section
      data-motion="members-share-prompts-agent-uses-space-context"
      data-space-boundary="ulysses"
      style={{
        position: "absolute",
        inset: 0,
        opacity: out,
        wordBreak: "keep-all",
      }}
    >
      <div
        className="product-fragment"
        style={{
          position: "absolute",
          left: 140,
          top: 195,
          width: 1640,
          height: 730,
          opacity: enter,
          scale: mix(0.93, 1, enter),
          background: "#ffffffaa",
          borderColor: colors.teal + "40",
          boxShadow: "0 40px 100px -60px #17352f40",
        }}
      >
        <header
          style={{
            padding: "30px 40px",
            display: "flex",
            alignItems: "center",
            gap: 18,
            borderBottom: `1px solid ${colors.line}`,
          }}
        >
          <Glyph name="spaces" size={34} style={{ color: colors.teal }} />
          <strong style={{ fontSize: 39, letterSpacing: -1.5 }}>{spaceExample.project}</strong>
          <span style={{ fontSize: 20, color: colors.muted }}>Space</span>
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: colors.teal,
              fontSize: 23,
            }}
          >
            <Glyph name="plus" size={24} /> {textFor("멤버 초대")}
          </span>
        </header>
      </div>
      {spaceExample.members.map((member, i) => {
        const join = clamp(reveal(frame, 1.65 + i * 0.55, fps));
        const prompt = beat(t, 3.5, 4.3);
        return (
          <div
            key={member}
            data-space-member={member}
            style={{
              position: "absolute",
              left: 490 + i * 470,
              top: mix(500, 370, prompt),
              translate: "-50% -50%",
              scale: mix(0.7, 1, join),
              opacity: join * (1 - beat(t, i < 2 ? 7.3 : 10, i < 2 ? 8 : 10.6)),
            }}
          >
            <Person label={member} />
          </div>
        );
      })}
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        {[455, 735].map((y, i) => (
          <path
            key={y}
            data-context-source={spaceExample.members[i]}
            d={`M685 ${y} C790 ${y} 795 570 870 570`}
            stroke={colors.teal}
            strokeWidth="2.5"
            fill="none"
            opacity={agent * 0.55}
            pathLength="1"
            strokeDasharray="1"
            strokeDashoffset={1 - agent}
          />
        ))}
        <path
          d="M1250 460C1150 460 1150 570 1050 570"
          stroke={colors.coral}
          strokeWidth="2.5"
          fill="none"
          opacity={follow * 0.65}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - follow}
        />
        <path
          d="M1050 610C1160 610 1150 745 1250 745"
          stroke={colors.teal}
          strokeWidth="2.5"
          fill="none"
          opacity={answer * 0.65}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - answer}
        />
      </svg>
      {spaceExample.contributions.map((qa, i) => {
        const show = beat(t, 4 + i, 4.7 + i);
        return (
          <article
            key={qa.member}
            className="product-fragment"
            data-shared-qa={qa.member}
            data-project="ulysses"
            style={{
              position: "absolute",
              width: 440,
              minHeight: 212,
              padding: "27px 30px",
              left: mix(490 + i * 470, 465, share),
              top: mix(630, 455 + i * 280, share),
              translate: "-50% -50%",
              opacity: show,
              scale: mix(0.9, 1, show),
              rotate: `${mix(i === 0 ? -4 : 4, 0, share)}deg`,
              background: "#fffefa",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                color: colors.teal,
                fontSize: 20,
              }}
            >
              <Glyph name="chat" size={24} />
              {textFor(qa.member)} · Q&A
            </div>
            <div
              style={{
                fontSize: 29,
                lineHeight: 1.4,
                marginTop: 18,
                letterSpacing: -0.8,
              }}
            >
              {textFor(qa.prompt)}
            </div>
            <div
              style={{
                fontSize: 21,
                marginTop: 20,
                paddingTop: 16,
                borderTop: `1px solid ${colors.line}`,
                color: colors.muted,
              }}
            >
              {textFor(qa.answer)}
            </div>
          </article>
        );
      })}
      <div
        data-space-context="questions-and-final-answers"
        style={{
          position: "absolute",
          left: 960,
          top: 570,
          translate: "-50% -50%",
          opacity: agent,
          scale: mix(0.8, 1, agent),
          textAlign: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 280,
            height: 280,
            left: "50%",
            top: 95,
            translate: "-50% -50%",
            borderRadius: "50%",
            border: `1px solid ${colors.teal}30`,
            boxShadow: `0 0 0 ${mix(0, 22, agent)}px ${colors.teal}06`,
          }}
        />
        <div
          style={{
            position: "relative",
            color: colors.teal,
            fontSize: 22,
            marginBottom: 28,
          }}
        >
          {textFor("Space 공용 맥락")}
        </div>
        <Mascot size={154} assetBase={assetBase} style={{ position: "relative" }} />
        <div
          style={{
            position: "relative",
            fontSize: 30,
            fontWeight: 600,
            marginTop: 26,
          }}
        >
          {textFor("내 에이전트")}
        </div>
        <div style={{ fontSize: 19, color: colors.muted, marginTop: 14 }}>
          {textFor("질문 · 최종 답변")}
        </div>
      </div>
      <article
        className="product-fragment"
        data-followup-member="멤버 C"
        style={{
          position: "absolute",
          left: 1480,
          top: 445,
          translate: "-50% -50%",
          width: 450,
          padding: "28px 32px",
          opacity: follow,
          scale: mix(0.92, 1, follow),
          borderColor: colors.coral + "65",
        }}
      >
        <div style={{ fontSize: 20, color: colors.coral }}>{textFor("멤버 C · 내 대화")}</div>
        <div style={{ fontSize: 29, lineHeight: 1.45, marginTop: 18 }}>
          {textFor(spaceExample.followup)}
        </div>
      </article>
      <article
        className="product-fragment"
        data-context-answer="ulysses"
        style={{
          position: "absolute",
          left: 1480,
          top: mix(775, 745, answer),
          translate: "-50% -50%",
          width: 450,
          padding: "28px 32px",
          opacity: answer,
          background: "#eef4ed",
          borderColor: colors.teal + "55",
        }}
      >
        <div
          style={{
            color: colors.teal,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 20,
          }}
        >
          <Mascot size={28} assetBase={assetBase} /> {textFor("내 에이전트")}
        </div>
        <strong
          style={{
            display: "block",
            fontSize: 30,
            lineHeight: 1.4,
            marginTop: 18,
          }}
        >
          {textFor(spaceExample.result)}
        </strong>
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          {spaceExample.contributions.map((qa) => (
            <span
              key={qa.member}
              data-context-reference={qa.member}
              style={{
                border: `1px solid ${colors.teal}35`,
                borderRadius: 9,
                padding: "9px 12px",
                fontSize: 18,
                color: colors.teal,
              }}
            >
              {textFor(qa.member)} · {textFor(qa.reference)}
            </span>
          ))}
        </div>
      </article>
    </section>
  );
};
