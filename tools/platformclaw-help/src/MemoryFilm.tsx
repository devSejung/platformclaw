import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { memoryDocuments } from "./demo-content";
import { beat, mix, reveal, clamp } from "./motion";
import { useMotionText } from "./MotionLocale";
import { DocumentCard, Glyph, colors } from "./ProductUI";

const documents = [
  { title: memoryDocuments[0], x: 730, y: 560, px: 960, py: 550, angle: 0 },
  { title: memoryDocuments[1], x: 960, y: 285, px: 590, py: 535, angle: -10 },
  { title: memoryDocuments[2], x: 1180, y: 660, px: 1320, py: 535, angle: 9 },
  { title: memoryDocuments[3], x: 1390, y: 340, px: 1190, py: 690, angle: 6 },
  { title: memoryDocuments[4], x: 470, y: 350, px: 720, py: 690, angle: -6 },
];
const links = [
  [0, 1],
  [0, 2],
  [1, 4],
  [2, 3],
  [0, 3],
];
export const MemoryFilm: React.FC = () => {
  const textFor = useMotionText();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const morph = beat(time, 5.6, 7.4);
  const explore = beat(time, 11, 12.25);
  const open = beat(time, 14.7, 15.8);
  const exit = 1 - beat(time, 17.5, 18.3);
  const nodes = documents.map((doc, i) => {
    const arrival = reveal(frame, 1.35 + i * 0.14, fps);
    return {
      ...doc,
      x: mix(960, mix(doc.px, doc.x, morph), arrival) - explore * 250,
      y: mix(680, mix(doc.py, doc.y, morph), arrival),
      arrival,
    };
  });
  return (
    <div style={{ position: "absolute", inset: 0, opacity: exit }} data-motion="documents-to-graph">
      <div
        style={{
          position: "absolute",
          left: 760,
          top: 175,
          fontSize: 20,
          color: colors.muted,
          letterSpacing: 6,
          opacity: beat(time, 1.8, 2.4) * (1 - morph),
        }}
      >
        {textFor("개인 Wiki · Ulysses")}
      </div>
      <div
        data-wiki-view-switch
        style={{
          position: "absolute",
          right: 160,
          top: 170,
          display: "flex",
          gap: 8,
          padding: 7,
          borderRadius: 13,
          background: colors.card,
          opacity: beat(time, 2, 2.6) * (1 - explore),
          fontSize: 21,
        }}
      >
        {["카드", "그래프"].map((label, i) => (
          <span
            key={label}
            style={{
              padding: "11px 20px",
              borderRadius: 9,
              color: i === (morph > 0.5 ? 1 : 0) ? "white" : colors.muted,
              background: i === (morph > 0.5 ? 1 : 0) ? colors.teal : "transparent",
            }}
          >
            {textFor(label)}
          </span>
        ))}
      </div>
      <svg
        width="1920"
        height="1080"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {links.map(([a, b], i) => {
          const draw = beat(time, 6.4 + i * 0.16, 7.6 + i * 0.16);
          const selected = open > 0.5 ? a === 2 || b === 2 : a === 0;
          return (
            <g key={i}>
              <line
                x1={nodes[a].x}
                y1={nodes[a].y}
                x2={nodes[b].x}
                y2={nodes[b].y}
                stroke={colors.teal}
                strokeWidth={selected ? 3 : 2}
                opacity={draw * (1 - explore * (selected ? 0 : 0.72)) * 0.65}
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - draw}
              />
            </g>
          );
        })}
        {/* Finish the exploration path before selection changes to the opened document. */}
        {links
          .filter(([a]) => a === 0)
          .map(([a, b], i) => {
            const start = 12.3 + i * 0.4;
            const travel = clamp((time - start) / 1.2);
            return (
              <circle
                key={`${a}-${b}`}
                data-wiki-pulse={`${a}-${b}`}
                r="7"
                fill={colors.teal}
                opacity={clamp((time - start) / 0.12) * (1 - clamp((time - start - 1.2) / 0.2))}
                cx={mix(nodes[a].x, nodes[b].x, travel)}
                cy={mix(nodes[a].y, nodes[b].y, travel)}
              />
            );
          })}
      </svg>
      {nodes.map((doc, i) => {
        const size = mix(i === 0 ? 380 : 310, 112, morph);
        const height = mix(i === 0 ? 296 : 246, 112, morph);
        const selected = open > 0.5 ? i === 2 : i === 0;
        const dim = selected ? 1 : 1 - explore * 0.55;
        return (
          <div
            key={doc.title}
            data-motion-object={doc.title}
            data-active-wiki-node={selected && morph > 0.9 ? "true" : "false"}
            style={{
              position: "absolute",
              left: doc.x,
              top: doc.y,
              width: size,
              height,
              translate: "-50% -50%",
              rotate: `${doc.angle * (1 - morph)}deg`,
              scale: mix(0.55, 1, doc.arrival),
              opacity: clamp(doc.arrival) * dim,
              zIndex: i === 0 ? 10 : 5 - i,
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: mix(24, 60, morph),
                border: `${selected && morph > 0.9 ? 2 : 1}px solid ${selected && morph > 0.9 ? colors.teal : colors.line}`,
                background: selected && morph > 0.9 ? colors.teal : colors.cream,
                boxShadow: `0 ${mix(28, 7, morph)}px ${mix(80, 30, morph)}px -14px #153e3325`,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: 32,
                  opacity: 1 - beat(time, 5.6, 6.25),
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    fontSize: 16,
                    color: colors.muted,
                  }}
                >
                  <Glyph name="doc" size={22} />
                  Wiki
                </div>
                <h3
                  style={{
                    fontSize: i === 0 ? 32 : 27,
                    letterSpacing: -1,
                    margin: "30px 0 24px",
                  }}
                >
                  {textFor(doc.title)}
                </h3>
                {[95, 76, 84, 50].map((w, n) => (
                  <div
                    key={n}
                    style={{
                      height: 6,
                      margin: "13px 0",
                      width: w + "%",
                      background: colors.line,
                      borderRadius: 4,
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  opacity: beat(time, 6, 7),
                  color: selected && morph > 0.9 ? "white" : colors.teal,
                }}
              >
                <Glyph name="doc" size={40} />
              </div>
            </div>
            {selected && explore > 0 && (
              <div
                style={{
                  position: "absolute",
                  inset: -12,
                  border: `1px solid ${colors.teal}`,
                  borderRadius: 60,
                  opacity: explore * 0.2,
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                top: 132,
                left: -120,
                right: -120,
                textAlign: "center",
                fontSize: 28,
                letterSpacing: -0.7,
                color: colors.ink,
                opacity: beat(time, 7, 7.7),
              }}
            >
              {textFor(doc.title)}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 1320,
          top: 330,
          width: 450,
          translate: `${(1 - explore) * 130}px 0`,
          opacity: explore,
          zIndex: 20,
        }}
      >
        <div
          className="product-fragment"
          style={{ padding: 36, opacity: 1 - open, scale: 1 - open * 0.08 }}
        >
          <div style={{ fontSize: 15, color: colors.muted, letterSpacing: 1 }}>
            {textFor("Wiki · 연결 문서")}
          </div>
          <h3 style={{ fontSize: 31 }}>{textFor(memoryDocuments[0])}</h3>
          <div style={{ height: 1, background: colors.line, margin: "26px 0" }} />
          {[memoryDocuments[1], memoryDocuments[2]].map((title) => (
            <div
              key={title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "17px 0",
                fontSize: 24,
              }}
            >
              <Glyph name="doc" size={24} />
              {textFor(title)}
              <Glyph name="arrow" size={20} style={{ marginLeft: "auto", color: colors.teal }} />
            </div>
          ))}
        </div>
        <DocumentCard
          title={memoryDocuments[2]}
          style={{
            position: "absolute",
            inset: 0,
            width: 450,
            opacity: open,
            translate: `0 ${(1 - open) * 55}px`,
            scale: mix(0.92, 1, open),
          }}
        >
          <div style={{ height: 1, background: colors.line, margin: "24px 0" }} />
          {["Jira 이슈와 설계 연결", "Confluence 변경 이력"].map((text, i) => (
            <div
              key={text}
              style={{
                display: "flex",
                gap: 14,
                alignItems: "center",
                fontSize: 24,
                marginTop: 25,
                opacity: beat(time, 15.4 + i * 0.2, 16 + i * 0.2),
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 6,
                  background: colors.teal,
                }}
              />
              {textFor(text)}
            </div>
          ))}
        </DocumentCard>
      </div>
    </div>
  );
};
