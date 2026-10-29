import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { chatExample, terminalCommands } from "./demo-content";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { Composer, ChatAnswer, Mascot, TerminalCard, Glyph, colors } from "./ProductUI";
import { typedPrefix } from "./typing";
import { VMConnection } from "./VMConnection";
export const ChatFilm: React.FC<{ assetBase?: string }> = ({ assetBase }) => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const enter = reveal(frame, 1.25, fps);
  const send = beat(t, 3.1, 3.6);
  const answer = beat(t, 3.7, 4.2);
  const workspace = beat(t, 5.25, 5.8);
  const connect = beat(t, 5.65, 5.9);
  const handoff = beat(t, 7.2, 7.6);
  const terminal = beat(t, 7.2, 7.8);
  const exit = 1 - beat(t, 12.6, 13.1);
  const secondTab = t >= 9.8;
  const command = terminalCommands[secondTab ? 1 : 0];
  const typingFrom = (secondTab ? 9.9 : 7.9) * fps;
  const typingTo = (secondTab ? 11.7 : 9.5) * fps;
  const typed = typedPrefix(command, frame, typingFrom, typingTo);
  const typing = frame >= typingFrom && frame < typingTo;
  const text = textFor(chatExample.prompt);
  return (
    <div
      style={{ position: "absolute", inset: 0, opacity: exit }}
      data-motion="chat-to-integrated-vm-terminal"
    >
      <section
        className="product-fragment"
        data-product-shell
        style={{
          position: "absolute",
          left: 150,
          top: 205,
          width: 1620,
          height: 740,
          opacity: workspace,
          borderRadius: 25,
          background: "#ffffff99",
        }}
      >
        <header
          style={{
            height: 70,
            padding: "0 34px",
            display: "flex",
            alignItems: "center",
            gap: 24,
            borderBottom: `1px solid ${colors.line}`,
          }}
        >
          <Mascot size={30} assetBase={assetBase} />
          <strong style={{ fontSize: 24 }}>{textFor("챗")}</strong>
          <span style={{ marginLeft: "auto", fontSize: 20, color: colors.teal }}>
            {t < 7 ? textFor("기본 서버") : "Ulysses VM"}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "9px 18px",
              borderRadius: 9,
              background: terminal > 0.5 ? "#e4ece6" : "transparent",
              color: colors.teal,
              fontSize: 20,
            }}
          >
            <Glyph name="terminal" size={24} />
            {textFor("터미널")}
          </span>
        </header>
      </section>
      <div
        style={{
          position: "absolute",
          left: mix(960, 550, workspace),
          top: mix(580, 380, send),
          width: 850,
          translate: "-50% -50%",
          scale: mix(0.85, 1, enter) * (1 - workspace * 0.18),
          opacity: clamp(enter) * (1 - workspace),
          rotate: `${mix(-3, 0, enter)}deg`,
        }}
      >
        <Composer
          text={typedPrefix(text, frame, 1.8 * fps, 2.9 * fps)}
          style={{ opacity: 1 - send }}
        />
        <div
          className="product-fragment"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            padding: "24px 35px",
            borderRadius: 27,
            fontSize: 30,
            background: colors.card,
            opacity: send,
          }}
        >
          {text}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: mix(960, 570, workspace),
          top: mix(mix(735, 610, answer), 445, workspace),
          translate: "-50% -50%",
          scale: mix(0.82, 1, answer) * (1 - workspace * 0.26),
          opacity: answer,
          rotate: `${mix(4, 0, answer)}deg`,
        }}
      >
        <ChatAnswer
          assetBase={assetBase}
          lines={Math.max(0, Math.min(3, Math.floor((t - 4.2) / 0.3) + 1))}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: mix(960, 1540, send),
          top: mix(240, 260, send),
          translate: "-50% -50%",
          scale: 1 - send * 0.5,
          opacity: enter * (1 - workspace),
        }}
      >
        <Mascot assetBase={assetBase} size={150} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 995,
          top: 345,
          opacity: connect * (1 - handoff),
          translate: `0 ${(1 - connect) * 35 - handoff * 45}px`,
          scale: mix(0.94, 1, connect) * (1 - handoff * 0.12),
        }}
      >
        <VMConnection />
      </div>
      <div
        style={{
          position: "absolute",
          left: 220,
          top: 600,
          translate: `0 ${(1 - terminal) * 180}px`,
          opacity: terminal,
        }}
      >
        <TerminalCard
          command={typed}
          secondTab={secondTab}
          caret={typing || Math.floor(frame / (fps / 2)) % 2 === 0}
          style={{ width: 1480, borderRadius: 12 }}
        />
      </div>
    </div>
  );
};
