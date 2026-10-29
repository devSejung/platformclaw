import React from "react";
import { Img, staticFile } from "remotion";
import { chatExample, sharedSkill } from "./demo-content";
import "./product-ui.css";
import { useMotionText } from "./MotionLocale";
import brand from "./product-brand.generated.json";

// Visual fragments ported from the pinned product views listed in the brand manifest.
// They contain example content and no product services, permissions or runtime fallback.
export const productTheme = brand.tokens as React.CSSProperties;
export const colors = {
  ink: brand.tokens["--text-strong"],
  teal: brand.tokens["--accent"],
  muted: brand.tokens["--muted"],
  cream: brand.tokens["--bg"],
  card: brand.tokens["--card"],
  line: brand.tokens["--border"],
  coral: brand.tokens["--accent-2"],
};
export const Mascot: React.FC<{
  size?: number;
  assetBase?: string;
  style?: React.CSSProperties;
}> = ({ size = 80, assetBase, style }) => {
  const textFor = useMotionText();
  return (
    <Img
      alt={textFor("PlatformClaw 마스코트")}
      src={
        assetBase
          ? new URL("brand/platformclaw-mascot.svg", assetBase).href
          : staticFile("brand/platformclaw-mascot.svg")
      }
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        imageRendering: "pixelated",
        ...style,
      }}
    />
  );
};
export const Glyph: React.FC<{
  name:
    | "doc"
    | "chat"
    | "server"
    | "vm"
    | "terminal"
    | "clock"
    | "key"
    | "lock"
    | "skill"
    | "plus"
    | "arrow"
    | "share"
    | "idea"
    | "spaces";
  size?: number;
  style?: React.CSSProperties;
}> = ({ name, size = 32, style }) => {
  const paths = {
    doc: (
      <>
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v5h4M9 12h6M9 16h6" />
      </>
    ),
    chat: <path d="M4 4h16v12H9l-5 4zM8 8h8M8 12h5" />,
    server: (
      <>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
      </>
    ),
    terminal: (
      <>
        <rect x="2" y="3" width="20" height="18" rx="3" />
        <path d="m6 8 4 4-4 4m7 0h5" />
      </>
    ),
    vm: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <rect x="6" y="6" width="12" height="5" rx="1" />
        <rect x="6" y="13" width="12" height="5" rx="1" />
        <path d="M9 8.5h.01M9 15.5h.01M12 8.5h3M12 15.5h3" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="8" r="5" />
        <path d="m12 12 9 9m-3-3 2-2m-5-1 2-2" />
      </>
    ),
    lock: (
      <>
        <rect x="4" y="10" width="16" height="12" rx="3" />
        <path d="M7 10V7a5 5 0 0 1 10 0v3m-5 5v3" />
      </>
    ),
    skill: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <path d="M8 7v10m8-10v10M5 12h14" />
      </>
    ),
    plus: <path d="M12 4v16M4 12h16" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    share: (
      <>
        <circle cx="5" cy="12" r="3" />
        <circle cx="19" cy="5" r="3" />
        <circle cx="19" cy="19" r="3" />
        <path d="m8 10 8-4M8 14l8 4" />
      </>
    ),
    idea: (
      <>
        <path d="M8 17h8M9 21h6M8 14a7 7 0 1 1 8 0v3H8zM12 1v2M2 8h2m16 0h2" />
      </>
    ),
    spaces: (
      <>
        <circle cx="8" cy="7" r="3" />
        <circle cx="18" cy="8" r="2.5" />
        <path d="M1 21v-3a7 7 0 0 1 14 0v3m2-8a5 5 0 0 1 6 5v3M13 3h9v2" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {paths[name]}
    </svg>
  );
};
export const DocumentCard: React.FC<{
  title: string;
  kind?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, kind = "Wiki", children, style }) => {
  const textFor = useMotionText();
  return (
    <article className="product-fragment wiki-document" style={style}>
      <div className="fragment-eyebrow">
        <Glyph name="doc" size={24} />
        <span>{textFor(kind)}</span>
      </div>
      <h3>{textFor(title)}</h3>
      {children ?? (
        <>
          <div className="paper-line" />
          <div className="paper-line" style={{ width: "82%" }} />
          <div className="paper-line" style={{ width: "58%" }} />
        </>
      )}
    </article>
  );
};
export const SkillCard: React.FC<{
  name?: string;
  summary?: string;
  author?: string;
  action?: string;
  version?: boolean;
  style?: React.CSSProperties;
}> = ({
  name = sharedSkill.name,
  summary = sharedSkill.summary,
  author,
  action = "세부 정보 보기 ↗",
  version = true,
  style,
}) => {
  const textFor = useMotionText();
  return (
    <article className="product-fragment skill-hub-card" style={style}>
      <span className="skill-hub-card__namespace">{sharedSkill.namespace}</span>
      <Glyph name="skill" size={43} style={{ margin: "20px 0", color: colors.teal }} />
      <strong className="skill-hub-card__name">{name}</strong>
      <span className="skill-hub-card__summary">{textFor(summary)}</span>
      {author && (
        <span style={{ fontSize: 15, color: colors.muted, marginTop: 18 }}>{textFor(author)}</span>
      )}
      {version && (
        <span className="skill-hub-card__meta">
          <span>v1.0.0</span>
          <span>{textFor(action)}</span>
        </span>
      )}
    </article>
  );
};
export const Composer: React.FC<{
  text?: string;
  style?: React.CSSProperties;
}> = ({ text = chatExample.prompt, style }) => {
  const textFor = useMotionText();
  return (
    <div className="product-fragment composer" style={style}>
      <span style={{ flex: 1, minWidth: 0 }}>{textFor(text)}</span>
      <span className="send-button">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 20V4m-6 6 6-6 6 6" />
        </svg>
      </span>
    </div>
  );
};
export const ChatAnswer: React.FC<{
  assetBase?: string;
  lines: number;
  style?: React.CSSProperties;
}> = ({ assetBase, lines, style }) => {
  const textFor = useMotionText();
  return (
    <div className="product-fragment chat-answer" style={style}>
      <div className="agent-heading">
        <Mascot size={42} assetBase={assetBase} />
        <strong>PlatformClaw</strong>
      </div>
      <h3>{textFor(chatExample.title)}</h3>
      {chatExample.rows.slice(0, lines).map((text, i) => (
        <div
          className="answer-line"
          key={text}
          data-chat-tool={i < 2 ? text.split(" · ")[0] : undefined}
          style={
            i < 2
              ? {
                  padding: "16px 19px",
                  border: `1px solid ${colors.line}`,
                  borderRadius: 12,
                  background: colors.cream,
                  marginBottom: 12,
                }
              : undefined
          }
        >
          {i < 2 ? (
            <Glyph name="doc" size={24} style={{ color: colors.teal }} />
          ) : (
            <span className="answer-index">0{i + 1}</span>
          )}
          <span>{textFor(text)}</span>
        </div>
      ))}
    </div>
  );
};
export const TerminalCard: React.FC<{
  command: string;
  secondTab: boolean;
  caret: boolean;
  style?: React.CSSProperties;
}> = ({ command, secondTab, caret, style }) => {
  const textFor = useMotionText();
  return (
    <section className="product-fragment terminal-fragment" data-product-terminal style={style}>
      <header className="tp-header" style={{ padding: "15px 24px" }}>
        <span style={{ gap: 24 }}>
          {[1, ...(secondTab ? [2] : [])].map((n) => (
            <span
              key={n}
              data-terminal-tab={n}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 16px",
                borderRadius: 8,
                background: n === (secondTab ? 2 : 1) ? "#e4ece6" : "transparent",
              }}
            >
              <Glyph name="terminal" size={22} /> {textFor("터미널")} {n}
              <span style={{ fontSize: 16, color: colors.muted }}>×</span>
            </span>
          ))}
          <Glyph name="plus" size={23} />
        </span>
        <span style={{ gap: 25, color: colors.muted }}>
          <span style={{ fontSize: 18 }}>Ulysses VM</span>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
          </svg>
          <span style={{ fontSize: 25 }}>×</span>
        </span>
      </header>
      <div
        className="terminal-empty"
        style={{
          height: 250,
          boxSizing: "border-box",
          fontFamily: "Consolas, monospace",
          fontSize: 31,
          lineHeight: 1.7,
          color: "#e7f0ec",
        }}
      >
        <div style={{ color: "#88c8b5", fontSize: 19, marginBottom: 24 }}>~/ulysses</div>
        <span style={{ color: "#88c8b5" }}>$ </span>
        <span data-terminal-command>{command}</span>
        <span
          style={{
            display: "inline-block",
            width: 13,
            height: 30,
            background: "#b9dcd2",
            verticalAlign: "text-bottom",
            marginLeft: 5,
            opacity: caret ? 1 : 0,
          }}
        />
      </div>
    </section>
  );
};
export const Person: React.FC<{
  label: string;
  style?: React.CSSProperties;
}> = ({ label, style }) => {
  const textFor = useMotionText();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 20,
        ...style,
      }}
    >
      <div
        style={{
          width: 104,
          height: 104,
          borderRadius: 60,
          background: "#e4ece6",
          border: `1px solid ${colors.line}`,
          display: "grid",
          placeItems: "center",
          color: colors.teal,
        }}
      >
        <svg
          width="58"
          height="58"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <circle cx="12" cy="7" r="4" />
          <path d="M4 22v-3a8 8 0 0 1 16 0v3" />
        </svg>
      </div>
      <span style={{ fontSize: 24, color: colors.ink }}>{textFor(label)}</span>
    </div>
  );
};
