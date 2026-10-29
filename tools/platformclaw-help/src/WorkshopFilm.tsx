import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { suggestedSkill } from "./demo-content";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { Mascot, Person, DocumentCard, Glyph, colors } from "./ProductUI";

export const WorkshopFilm: React.FC<{ assetBase?: string }> = ({ assetBase }) => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const enter = reveal(frame, 1.3, fps),
    propose = beat(t, 4.3, 5.7),
    review = beat(t, 8.5, 10),
    out = 1 - beat(t, 11.7, 12.3);
  return (
    <div
      style={{ position: "absolute", inset: 0, opacity: out }}
      data-motion="agent-proposes-human-reviews"
    >
      <div
        style={{
          position: "absolute",
          left: mix(780, 410, propose),
          top: 520,
          translate: "-50% -50%",
          scale: enter,
          opacity: clamp(enter),
        }}
      >
        <Mascot assetBase={assetBase} size={210} />
        <div style={{ fontSize: 26, textAlign: "center", marginTop: 18 }}>Agent</div>
      </div>
      {["ULY-142", "ULY-155", "ULY-163"].map((label, i) => (
        <div
          key={label}
          className="product-fragment"
          style={{
            position: "absolute",
            left: mix(330, 640, propose),
            top: mix(325 + i * 210, 520, propose),
            translate: "-50% -50%",
            padding: "24px 30px",
            width: 370,
            fontSize: 21,
            opacity: beat(t, 1.6 + i * 0.6, 2.2 + i * 0.6) * (1 - propose),
            scale: mix(1, 0.4, propose),
            rotate: `${(i - 1) * 4 * (1 - propose)}deg`,
          }}
        >
          <div style={{ fontSize: 23, color: colors.teal }}>{label} · Ulysses</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 18,
              marginTop: 18,
            }}
          >
            <Glyph name="doc" size={21} />
            Jira <Glyph name="arrow" size={18} />
            Confluence <Glyph name="arrow" size={18} />
            {textFor("점검")}
          </div>
        </div>
      ))}
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <path
          d="M545 520H705"
          stroke={colors.teal}
          strokeWidth="2"
          opacity={propose * 0.55}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - propose}
        />
        <path
          d="M1300 520H1510"
          stroke={colors.teal}
          strokeWidth="2"
          opacity={review * 0.55}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - review}
        />
        <g
          transform={`translate(570 335) scale(${propose})`}
          opacity={propose * (1 - review * 0.6)}
          stroke={colors.teal}
          strokeWidth="2"
          fill="none"
        >
          <path d="M0-20V-9M0 9V20M-20 0H-9M9 0H20M-14-14-6-6M6 6l8 8M-14 14-6 6M6-6l8-8" />
        </g>
      </svg>
      <div
        style={{
          position: "absolute",
          left: 1010,
          top: 550,
          translate: `-50% ${mix(-30, -50, propose)}%`,
          opacity: propose,
          scale: mix(0.8, 1, propose),
        }}
      >
        <DocumentCard
          title={suggestedSkill.title}
          kind="Agent 제안"
          style={{ width: 590, minHeight: 390, padding: 40 }}
        >
          <div style={{ fontSize: 16, color: colors.muted }}>{suggestedSkill.name}</div>
          <div
            data-workshop-reusable-flow
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              margin: "30px 0",
              color: colors.teal,
              fontSize: 22,
            }}
          >
            <Glyph name="skill" size={30} />
            SKILL.md
            <Glyph name="arrow" size={23} />
            Jira
            <Glyph name="arrow" size={23} />
            {textFor("설계 점검")}
          </div>
          <div style={{ display: "flex", gap: 14, opacity: review }}>
            <span
              style={{
                background: colors.teal,
                color: "white",
                padding: "13px 29px",
                borderRadius: 12,
                fontSize: 20,
              }}
            >
              {textFor("검토")}
            </span>
            <span
              style={{
                background: colors.card,
                padding: "13px 29px",
                borderRadius: 12,
                fontSize: 20,
              }}
            >
              {textFor("보류")}
            </span>
          </div>
        </DocumentCard>
      </div>
      <div
        style={{
          position: "absolute",
          left: 1620,
          top: 455,
          translate: `${(1 - review) * 100}px 0`,
          opacity: review,
        }}
      >
        <Person label="사용자" />
        <div
          style={{
            fontSize: 18,
            color: colors.teal,
            textAlign: "center",
            marginTop: 20,
          }}
        >
          {textFor("제안 검토")}
        </div>
      </div>
    </div>
  );
};
