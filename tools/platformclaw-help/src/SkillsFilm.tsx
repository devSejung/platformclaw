import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { agentSkills, projects } from "./demo-content";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { Glyph, Mascot, DocumentCard, colors } from "./ProductUI";

export const SkillsFilm: React.FC<{ assetBase?: string }> = ({ assetBase }) => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const enter = reveal(frame, 1.3, fps),
    use = beat(t, 4.1, 5.6),
    tools = beat(t, 6, 7.2),
    result = beat(t, 9, 10.2),
    out = 1 - beat(t, 11.7, 12.3);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: out }} data-motion="agent-uses-skills">
      <div
        className="product-fragment"
        data-skill-task
        style={{
          position: "absolute",
          left: 960,
          top: 225,
          translate: "-50% -50%",
          padding: "22px 36px",
          fontSize: 29,
          opacity: clamp(enter) * (1 - result),
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Glyph name="chat" size={28} />
        {textFor("Thetis 설계 변경 검토")}
      </div>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        {agentSkills.map((s, i) => (
          <g key={s.name}>
            <path
              d={`M740 ${420 + i * 230} C800 ${420 + i * 230} 790 520 835 520`}
              stroke={colors.teal}
              strokeWidth="2"
              fill="none"
              opacity={use * 0.5}
            />
            <path
              d={`M1080 520 C1180 520 1170 ${380 + i * 320} 1300 ${380 + i * 320}`}
              stroke={colors.teal}
              strokeWidth="2"
              fill="none"
              opacity={tools * 0.55}
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - tools}
            />
            <circle
              cx={mix(1090, 1290, beat(t, 7.2 + i * 0.25, 8.4 + i * 0.25))}
              cy={mix(520, 380 + i * 320, beat(t, 7.2 + i * 0.25, 8.4 + i * 0.25))}
              r="7"
              fill={colors.teal}
              opacity={tools * (1 - result)}
            />
          </g>
        ))}
      </svg>
      {agentSkills.map((skill, i) => {
        const entry = reveal(frame, 1.5 + i * 0.2, fps);
        return (
          <div
            className="product-fragment"
            key={skill.name}
            data-agent-skill={skill.name}
            style={{
              position: "absolute",
              left: mix(330, 575, use),
              top: 420 + i * 230,
              width: 355,
              padding: 28,
              translate: "-50% -50%",
              scale: entry * mix(1, 0.84, use),
              opacity: clamp(entry),
              rotate: `${(i === 0 ? -5 : 5) * (1 - use)}deg`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 15,
                color: colors.teal,
              }}
            >
              <Glyph name="skill" size={25} />
              SKILL.md
            </div>
            <strong style={{ display: "block", fontSize: 25, marginTop: 18 }}>{skill.name}</strong>
            <div style={{ fontSize: 18, color: colors.muted, marginTop: 12 }}>
              {skill.steps.map((step, n) => (
                <div
                  key={step}
                  style={{
                    marginTop: 10,
                    color: use > 0.8 ? colors.teal : colors.muted,
                  }}
                >
                  {n + 1}. {textFor(step)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 960,
          top: 510,
          translate: "-50% -50%",
          scale: enter,
          opacity: clamp(enter),
        }}
      >
        <div
          style={{
            width: 280,
            height: 280,
            borderRadius: 70,
            display: "grid",
            placeItems: "center",
            background: colors.cream,
            border: `1px solid ${colors.line}`,
            boxShadow: "0 35px 100px -50px #0f7c7255",
          }}
        >
          <Mascot assetBase={assetBase} size={205} />
        </div>
        <div style={{ textAlign: "center", fontSize: 28, marginTop: 24 }}>Agent</div>
      </div>
      {agentSkills.map((skill, i) => (
        <div
          key={skill.name}
          style={{
            position: "absolute",
            left: 1310,
            top: 260 + i * 320,
            translate: `${(1 - tools) * 160}px 0`,
            opacity: tools,
          }}
        >
          <DocumentCard
            title={i === 0 ? projects[1].issue : projects[1].document}
            kind={skill.tool}
            style={{ width: 410, minHeight: 230 }}
          >
            <div style={{ fontSize: 20, color: colors.teal, marginTop: 24 }}>Thetis</div>
            <div className="paper-line" />
          </DocumentCard>
        </div>
      ))}
      <div
        className="product-fragment"
        style={{
          position: "absolute",
          left: 960,
          top: 855,
          translate: `-50% ${mix(20, -50, result)}%`,
          opacity: result,
          padding: "24px 42px",
          fontSize: 27,
          display: "flex",
          gap: 17,
          alignItems: "center",
        }}
      >
        <Glyph name="doc" size={28} />
        {textFor("Thetis 과제 검토")}
      </div>
    </div>
  );
};
