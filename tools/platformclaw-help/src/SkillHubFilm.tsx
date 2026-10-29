import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { sharedSkill } from "./demo-content";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { Person, SkillCard, Glyph, colors } from "./ProductUI";

export const SkillHubFilm: React.FC = () => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const enter = reveal(frame, 1.4, fps),
    publish = beat(t, 4.8, 6.2),
    share = beat(t, 8.3, 10),
    out = 1 - beat(t, 11.7, 12.3);
  return (
    <div
      style={{ position: "absolute", inset: 0, opacity: out }}
      data-motion="user-authored-skill-sharing"
    >
      <div
        className="product-fragment"
        data-user-authored-skill-file
        style={{
          position: "absolute",
          left: mix(565, 960, publish),
          top: mix(235, 550, publish),
          translate: "-50% -50%",
          width: 300,
          padding: 24,
          opacity: clamp(enter) * (1 - publish),
          scale: mix(1, 0.4, publish),
          rotate: `${mix(-5, 0, publish)}deg`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 24,
            color: colors.teal,
          }}
        >
          <Glyph name="doc" size={27} />
          SKILL.md
        </div>
        <div className="paper-line" style={{ marginTop: 20 }} />
        <div className="paper-line" style={{ width: "70%" }} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 235,
          top: 490,
          translate: "-50% -50%",
          opacity: clamp(enter),
          scale: enter,
        }}
      >
        <Person label="작성자 A" />
      </div>
      <div
        className="product-fragment"
        style={{
          position: "absolute",
          left: 960,
          top: 550,
          width: 600,
          height: 630,
          translate: "-50% -50%",
          opacity: publish,
          scale: mix(0.92, 1, publish),
          background: "#f1f4ee",
        }}
      >
        <div style={{ padding: "30px 36px", fontSize: 27, fontWeight: 600 }}>Skill Hub</div>
        <div
          style={{
            position: "absolute",
            bottom: 26,
            left: 36,
            right: 36,
            fontSize: 17,
            color: colors.teal,
          }}
        >
          {textFor("공유 범위 · Vanguard 팀")}
        </div>
      </div>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <path
          d="M300 550H735"
          stroke={colors.teal}
          strokeWidth="2"
          fill="none"
          opacity={publish * 0.5}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - publish}
        />
        {[0, 1].map((i) => (
          <path
            key={i}
            d={`M1180 550 C1300 550 1340 ${360 + i * 360} 1590 ${360 + i * 360}`}
            stroke={colors.teal}
            strokeWidth="2"
            fill="none"
            opacity={share * 0.6}
            pathLength="1"
            strokeDasharray="1"
            strokeDashoffset={1 - share}
          />
        ))}
      </svg>
      <div
        style={{
          position: "absolute",
          left: mix(565, 960, publish),
          top: 550,
          translate: "-50% -50%",
          opacity: clamp(enter),
          scale: mix(0.86, 1, publish),
          rotate: `${mix(-7, 0, publish)}deg`,
        }}
      >
        <SkillCard
          name={sharedSkill.name}
          summary={sharedSkill.summary}
          author="작성자 A"
          action="공유 ↗"
        />
      </div>
      {[0, 1].map((i) => (
        <React.Fragment key={i}>
          <div
            style={{
              position: "absolute",
              left: 1680,
              top: 300 + i * 360,
              translate: "-50% 0",
              opacity: share,
              scale: mix(0.85, 1, share),
            }}
          >
            <Person label={`사용자 ${i === 0 ? "B" : "C"}`} />
          </div>
          <div
            className="product-fragment"
            style={{
              position: "absolute",
              left: mix(1100, 1460, share),
              top: 360 + i * 360,
              translate: "-50% -50%",
              opacity: share,
              width: 230,
              height: 150,
              borderRadius: 27,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              gap: 15,
              color: colors.teal,
              boxShadow: "0 20px 50px -30px #0f7c7260",
            }}
          >
            <Glyph name="skill" size={38} />
            <span style={{ fontSize: 22 }}>{textFor("내 스킬")}</span>
            <span style={{ fontSize: 16, color: colors.muted }}>
              v1.0.0 · {textFor("가져오기")}
            </span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
