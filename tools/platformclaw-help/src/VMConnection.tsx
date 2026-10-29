import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { beat, clamp, mix } from "./motion";
import { useMotionText } from "./MotionLocale";
import { colors, Glyph } from "./ProductUI";

// Port of execution-settings-shell.ts: the same diagram, driven by frames instead of CSS clocks.
export const VMConnection: React.FC = () => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const phase = time < 6.6 ? "connecting" : time < 7 ? "switching" : "success";
  const packet = clamp((time - 5.9) / 0.7);
  const transfer = beat(time, 6.6, 7);
  const check = beat(time, 7, 7.2);
  const arrival = clamp((time - 7) / 0.3);
  return (
    <section className="product-fragment vm-connection-film" data-vm-phase={phase}>
      <div className="execution-diagram">
        <div className="execution-endpoint" style={{ opacity: 1 - transfer * 0.55 }}>
          <Glyph name="server" size={48} />
          <span>{textFor("기본 서버")}</span>
        </div>
        <div className="execution-link">
          <span className="execution-track">
            <span className="execution-route-fill" style={{ scale: `${transfer} 1` }} />
          </span>
          <span
            className="execution-packet"
            style={{
              left: `${packet * 100}%`,
              opacity: phase === "connecting" ? Math.min(packet / 0.2, (1 - packet) / 0.2, 1) : 0,
            }}
          />
          <span
            className="execution-transfer"
            style={{
              left: `${transfer * 100}%`,
              opacity: phase === "switching" ? 1 : 0,
            }}
          >
            <Glyph name="arrow" size={24} />
          </span>
          <span className="execution-orb" style={{ opacity: phase === "switching" ? 0 : 1 }}>
            {phase === "connecting" ? (
              <span className="execution-spinner" style={{ rotate: `${(time - 5.9) * 360}deg` }} />
            ) : (
              <svg
                width="38"
                height="38"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--ok)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path
                  d="m5 12 4 4 10-10"
                  pathLength="1"
                  strokeDasharray="1"
                  strokeDashoffset={1 - check}
                />
              </svg>
            )}
          </span>
        </div>
        <div
          className="execution-endpoint"
          style={{ color: phase === "success" ? "var(--ok)" : colors.teal }}
        >
          <Glyph
            name="vm"
            size={48}
            style={{
              borderRadius: 10,
              boxShadow: `0 0 0 ${arrival * 18}px rgba(67,140,85,${(1 - arrival) * 0.28})`,
            }}
          />
          <span>Ulysses VM</span>
        </div>
      </div>
      <h2>
        {phase === "connecting"
          ? textFor("VM 연결 중")
          : phase === "switching"
            ? textFor("작업 위치 전환 중")
            : textFor("작업 준비 완료")}
      </h2>
      <div className="execution-steps">
        {["VM 연결", "작업 위치"].map((label, i) => (
          <span
            key={label}
            style={{
              color: (i === 0 ? phase !== "connecting" : phase === "success")
                ? "var(--ok)"
                : colors.muted,
            }}
          >
            <span style={{ scale: mix(0.8, 1, i === 0 ? transfer : check) }} />
            {textFor(label)}
          </span>
        ))}
      </div>
    </section>
  );
};
