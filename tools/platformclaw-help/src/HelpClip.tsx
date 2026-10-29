import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { ChatFilm } from "./ChatFilm";
import { CredentialsFilm } from "./CredentialsFilm";
import { CronFilm } from "./CronFilm";
import { motionText, type MotionLocale } from "./i18n";
import { MemoryFilm } from "./MemoryFilm";
import { beat, mix, reveal } from "./motion";
import { MotionLocaleContext } from "./MotionLocale";
import { productTheme, Mascot, colors } from "./ProductUI";
import { SkillHubFilm } from "./SkillHubFilm";
import { SkillsFilm } from "./SkillsFilm";
import { SpacesFilm } from "./SpacesFilm";
import { topics, type TopicId } from "./topics";
import { WorkshopFilm } from "./WorkshopFilm";

export const HelpClip: React.FC<{
  topicId: TopicId;
  assetBase?: string;
  locale?: MotionLocale;
}> = ({ topicId, assetBase, locale = "ko" }) => {
  const topic = topics.find((t) => t.id === topicId)!;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const introOut = beat(time, 1.1, 1.8);
  const outro = beat(time, topic.seconds - 2, topic.seconds - 1.2);
  const introRise = reveal(frame, 0, fps);
  return (
    <MotionLocaleContext.Provider value={locale}>
      <AbsoluteFill
        lang={locale}
        role="img"
        aria-label={motionText(topic.description, locale)}
        data-motion-topic={topicId}
        data-motion-frame={frame}
        data-motion-locale={locale}
        style={{
          ...productTheme,
          background: "#f6f6f3",
          color: colors.ink,
          fontFamily: '"Segoe UI", "Malgun Gothic", sans-serif',
          overflow: "hidden",
          perspective: 1800,
          wordBreak: locale === "ko" ? "keep-all" : "normal",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse at 50% 35%,#ffffff 8%,#f6f6f3 73%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 95,
            top: 65,
            display: "flex",
            alignItems: "center",
            gap: 13,
            opacity: 1 - outro,
          }}
        >
          <Mascot size={46} assetBase={assetBase} />
          <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: -0.8 }}>PlatformClaw</span>
        </div>
        <Sequence name={`${topic.word} · motion`} durationInFrames={topic.seconds * fps}>
          {topicId === "memory" ? (
            <MemoryFilm />
          ) : topicId === "chat" ? (
            <ChatFilm assetBase={assetBase} />
          ) : topicId === "spaces" ? (
            <SpacesFilm assetBase={assetBase} />
          ) : topicId === "skills" ? (
            <SkillsFilm assetBase={assetBase} />
          ) : topicId === "skill-hub" ? (
            <SkillHubFilm />
          ) : topicId === "skill-workshop" ? (
            <WorkshopFilm assetBase={assetBase} />
          ) : topicId === "cron" ? (
            <CronFilm assetBase={assetBase} />
          ) : (
            <CredentialsFilm assetBase={assetBase} />
          )}
        </Sequence>
        <Sequence name={`${topic.word} · identity`} durationInFrames={Math.round(1.9 * fps)}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity: 1 - introOut,
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 150,
                top: 365,
                fontSize: topic.word === "Credentials" ? 170 : 205,
                fontWeight: 650,
                letterSpacing: -11,
                translate: `0 ${mix(45, 0, introRise) - introOut * 100}px`,
                lineHeight: 1.1,
              }}
            >
              {topic.word}
              <span style={{ color: colors.teal }}>.</span>
            </div>
            <div
              style={{
                position: "absolute",
                left: 1410,
                top: 320,
                scale: mix(0.85, 1, introRise),
                rotate: `${mix(-5, 0, introRise)}deg`,
                translate: `0 ${introOut * 90}px`,
              }}
            >
              <Mascot size={290} assetBase={assetBase} />
            </div>
          </div>
        </Sequence>
        <Sequence
          name="PlatformClaw · signature"
          from={Math.round((topic.seconds - 2) * fps)}
          durationInFrames={Math.round(2 * fps)}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 36,
              opacity: outro,
              translate: `0 ${(1 - outro) * 30}px`,
            }}
          >
            <Mascot size={132} assetBase={assetBase} />
            <div>
              <div style={{ fontSize: 65, fontWeight: 650, letterSpacing: -3 }}>PlatformClaw</div>
              <div
                style={{
                  fontSize: 26,
                  marginTop: 12,
                  color: colors.teal,
                  letterSpacing: -0.5,
                }}
              >
                {topic.word}
              </div>
            </div>
          </div>
        </Sequence>
      </AbsoluteFill>
    </MotionLocaleContext.Provider>
  );
};
