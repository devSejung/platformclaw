import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { Glyph, Mascot, colors } from "./ProductUI";

export const CronFilm: React.FC<{ assetBase?: string }> = ({ assetBase }) => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const enter = clamp(reveal(frame, 1.4, fps));
  const schedule = beat(t, 3.1, 4.2);
  const runTimes = [5, 8.5, 12];
  const out = 1 - beat(t, durationInFrames / fps - 2.3, durationInFrames / fps - 1.7);
  return (
    <section
      data-motion="scheduled-prompt-agent-runs"
      style={{ position: "absolute", inset: 0, opacity: out }}
    >
      <article
        className="product-fragment"
        data-scheduled-prompt
        style={{
          position: "absolute",
          left: 330,
          top: 550,
          width: 460,
          padding: 36,
          translate: "-50% -50%",
          opacity: enter,
          scale: mix(0.85, 1, enter),
          wordBreak: "keep-all",
        }}
      >
        <div
          style={{
            fontSize: 20,
            color: colors.teal,
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <Glyph name="chat" size={26} />
          {textFor("프롬프트")}
        </div>
        <h3 style={{ fontSize: 34 }}>{textFor("Vanguard Jira 점검")}</h3>
        <div style={{ fontSize: 26, lineHeight: 1.5 }}>
          {textFor("Jira 이슈와 Confluence 설계 변경점 점검")}
        </div>
        <div
          style={{
            display: "flex",
            gap: 14,
            alignItems: "center",
            fontSize: 25,
            marginTop: 34,
            color: colors.teal,
            opacity: schedule,
          }}
        >
          <Glyph name="clock" size={29} />
          {textFor("매일 · 09:00")}
        </div>
      </article>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <path
          d="M560 570H850"
          stroke={colors.teal}
          strokeWidth="2"
          fill="none"
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - schedule}
          opacity={schedule * 0.5}
        />
        <path d="M720 290H1660" stroke={colors.line} strokeWidth="2" opacity={schedule} />
        {runTimes.map((at, i) => {
          const run = beat(t, at, at + 0.8);
          return (
            <g key={at} opacity={schedule}>
              <circle
                cx={760 + i * 410}
                cy="290"
                r="13"
                fill={t >= at ? colors.teal : colors.cream}
                stroke={colors.teal}
              />
              <text x={760 + i * 410} y="245" textAnchor="middle" fill={colors.muted} fontSize="22">
                10/{29 + i} · 09:00
              </text>
              <path
                d={`M${760 + i * 410} 305 Q${760 + i * 410} 390 990 465`}
                fill="none"
                stroke={colors.teal}
                strokeWidth="2"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - run}
                opacity={run * 0.35}
              />
              <path
                d={`M1100 570 C1200 570 1220 ${440 + i * 155} 1320 ${440 + i * 155}`}
                fill="none"
                stroke={colors.teal}
                strokeWidth="2"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - run}
                opacity={run * 0.45}
              />
            </g>
          );
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          left: 990,
          top: 570,
          translate: "-50% -50%",
          opacity: schedule,
          scale: mix(0.8, 1, schedule),
          textAlign: "center",
        }}
      >
        <Mascot size={190} assetBase={assetBase} />
        <div style={{ fontSize: 29, marginTop: 26 }}>Agent</div>
      </div>
      {runTimes.map((at, i) => {
        const run = beat(t, at + 0.7, at + 1.4);
        return (
          <article
            key={at}
            className="product-fragment"
            data-cron-run={i + 1}
            style={{
              position: "absolute",
              left: 1340,
              top: 365 + i * 155,
              width: 390,
              padding: "23px 28px",
              opacity: run,
              translate: `${(1 - run) * 80}px 0`,
              scale: mix(0.9, 1, run),
            }}
          >
            <div
              style={{
                fontSize: 18,
                color: colors.teal,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Glyph name="doc" size={22} />
              {textFor("실행 기록")} · 10/{29 + i}
            </div>
            <strong style={{ display: "block", fontSize: 26, marginTop: 15 }}>
              {textFor("Vanguard 점검")}
            </strong>
          </article>
        );
      })}
    </section>
  );
};
