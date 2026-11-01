/** Agent-facing inline chat widget tool. */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { BoardWidgetPutResult } from "../../packages/gateway-protocol/src/index.js";
import type { SandboxFsBridge } from "../agents/sandbox/fs-bridge.types.js";
import { optionalStringEnum } from "../agents/schema/string-enum.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "../agents/tools/common.js";
import {
  callInProcessGatewayTool,
  type InProcessGatewayCaller,
} from "../agents/tools/in-process-gateway.js";
import { normalizeBoardWidgetDeclared } from "../boards/board-capabilities.js";
import { assertWidgetHtmlSize, WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import { createCanvasDocument } from "./documents.js";
import { embedWidgetWorkspaceImages } from "./widget-local-images.js";
import { findWidgetScriptSyntaxError } from "./widget-script-syntax.js";
import { buildWidgetDocument } from "./wrap.js";

const SHOW_WIDGET_REQUIRED_CLIENT_CAPS = ["inline-widgets"];
const WIDGET_CODE_MAX_CHARS = 262_144;
const PINNED_WIDGET_MAX_UTF8_BYTES = 256 * 1024;
const WIDGET_MAX_PER_SCOPE = 32;

const ShowWidgetToolSchema = Type.Object({
  title: Type.String(),
  widget_code: Type.String({
    description:
      "Raw HTML or SVG string, not a tool response. With widget_path, preserve the complete saved file text, including all leading and trailing whitespace. Command output may trim whitespace: retain the exact saved string, or JSON-encode file text when reading and JSON.parse the result.",
  }),
  widget_path: Type.Optional(
    Type.String({
      description:
        "Saved HTML file path whose directory resolves relative workspace image references",
    }),
  ),
  name: Type.Optional(
    Type.String({
      pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
      description: "Stable dashboard widget name when pinning",
    }),
  ),
  pin: Type.Optional(
    Type.Boolean({ description: "Also pin this widget to the session dashboard" }),
  ),
  tab: Type.Optional(
    Type.String({ pattern: "^[a-z0-9-]{1,40}$", description: "Dashboard tab slug" }),
  ),
  size: optionalStringEnum(["sm", "md", "lg", "xl", "full"] as const, {
    description: "Dashboard size: sm, md, lg, xl, or full",
  }),
  presentation: optionalStringEnum(["card", "full-bleed", "frameless"] as const, {
    description: "Pinned dashboard frame: card, full-bleed, or frameless",
  }),
  after: Type.Optional(
    Type.String({
      pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
      description: "Place after this dashboard widget name",
    }),
  ),
  capabilities: Type.Optional(
    Type.Object({
      netOrigins: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exact HTTPS origins the pinned widget may fetch after approval",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Pinned widget host tools, such as prompt, sessions.list, or cron.trigger:<jobId>",
        }),
      ),
    }),
  ),
});

type ShowWidgetToolOptions = {
  /** Presentation support only; current Gateway authority still gates dashboard effects. */
  supportsDashboard?: boolean;
  sessionId?: string;
  agentId?: string;
  agentSessionKey?: string;
  stateDir?: string;
  callGateway?: InProcessGatewayCaller;
  workspaceDir?: string;
  sandbox?: { root: string; bridge: SandboxFsBridge };
};

function slugWidgetName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug && slug.length <= 64) {
    return slug;
  }
  const suffix = createHash("sha256").update(title).digest("hex").slice(0, 8);
  const prefix = (slug || "widget").slice(0, 55).replace(/-+$/gu, "") || "widget";
  return `${prefix}-${suffix}`;
}

function generatedWidgetIdentity(title: string, preferredName: string) {
  const key = createHash("sha256").update(title.trim().normalize("NFC")).digest("hex");
  const prefix = preferredName.slice(0, 55).replace(/-+$/gu, "") || "widget";
  return {
    source: "show_widget" as const,
    key,
    fallbackName: `${prefix}-${key.slice(0, 8)}`,
  };
}

function boardWidgetTitle(title: string): string | undefined {
  const normalized = title.trim();
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
}

function resolveRetentionScope(options: ShowWidgetToolOptions): string {
  const scope = options.sessionId
    ? `session:${options.sessionId}`
    : `agent:${options.agentId ?? "default"}`;
  return createHash("sha256").update(scope).digest("hex");
}

function assertPinnedWidgetDocumentSize(html: string): void {
  if (Buffer.byteLength(html, "utf8") > PINNED_WIDGET_MAX_UTF8_BYTES) {
    throw new WidgetHtmlInputError(
      `pin exceeds effective dashboard budget (${PINNED_WIDGET_MAX_UTF8_BYTES} UTF-8 bytes after wrapping)`,
    );
  }
}

/** Creates a self-contained widget hosted by OpenClaw core. */
export function createShowWidgetTool(options: ShowWidgetToolOptions = {}): AnyAgentTool {
  const supportsDashboard = options.supportsDashboard === true;
  const gatewayCall = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "Show Widget",
    name: "show_widget",
    description: [
      "Use for interactive comparisons, explanations, quizzes, and choices; a user-clicked button can ask the agent a follow-up. Prefer clear text or tables when sufficient.",
      "Keep filtering, selection, and calculations local. In Control UI, use a clearly labeled button with await openclaw.prompt.send(text) for an agent follow-up, including the selected values and requested action. It returns true only when the chat queue accepts the message; later delivery failures appear in chat with Retry. The widget cannot read the agent reply.",
      "Prompt buttons require a real click in the visible, focused widget. Never send prompts on load or every filter change; slash commands are rejected. Native renderers do not provide this conversation bridge.",
      supportsDashboard
        ? "Set pin=true for an explicitly requested session dashboard; reuse name to update it. Placement uses tab, size sm|md|lg|xl|full, presentation card|full-bleed|frameless, and after. Declare pinned capabilities.netOrigins or capabilities.tools for approval before data access. Dashboard-only APIs: openclaw.state.emit(payload), openclaw.data.read(bindingId, params?), and openclaw.cron.trigger(jobId)."
        : "This surface supports inline widgets only; dashboard placement, network grants, and dashboard data/action APIs are unavailable.",
      "Send self-contained HTML/SVG in widget_code. For a saved HTML deliverable, attach the file through the current reply contract instead; web chat offers Preview without repeating its contents here.",
      "Use inline CSS and JavaScript, inline SVG, data:image URLs, or document-created blob images. For static relative workspace images, pass widget_path and its exact unchanged complete text as widget_code, preserving whitespace. Paths are resolved through the active Basic or VM workspace; never use a browser file:// URL. srcset, CSS local/HTTP url() assets, and HTTP(S) images are unsupported.",
      "Use host theme variables --text --muted --card --border --accent --font-body --font-mono; transparent outer background and fluid widths. Bare controls and headings are styled; .card .row .metric .muted .badge and button.primary are available.",
      "Inline JavaScript syntax errors return a line and column; fix and retry. Verify the delivered widget, important clicks, and narrow layout when the actual chat surface is accessible. Hosting success alone is not rendering proof; state any verification gap.",
    ].join(" "),
    parameters: supportsDashboard
      ? ShowWidgetToolSchema
      : Type.Pick(ShowWidgetToolSchema, ["title", "widget_code", "widget_path"]),
    requiredClientCaps: SHOW_WIDGET_REQUIRED_CLIENT_CAPS,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      if (
        !supportsDashboard &&
        ["pin", "name", "tab", "size", "presentation", "after", "capabilities"].some(
          (name) => params[name] !== undefined,
        )
      ) {
        throw new WidgetHtmlInputError(
          "Dashboard widgets are unavailable on this surface. Omit pin, placement, and capabilities; show an inline widget instead.",
        );
      }
      const title = readStringParam(params, "title", { required: true });
      const rawWidgetCode = readStringParam(params, "widget_code", {
        required: true,
        trim: false,
      });
      if (!rawWidgetCode.trim()) {
        throw new WidgetHtmlInputError("widget_code required");
      }
      assertWidgetHtmlSize(rawWidgetCode, WIDGET_CODE_MAX_CHARS, {
        inputName: "widget_code",
        unit: "characters",
      });
      const scriptError = findWidgetScriptSyntaxError(rawWidgetCode);
      if (scriptError) {
        throw new WidgetHtmlInputError(
          `widget_code has a JavaScript syntax error in inline script ${scriptError.scriptIndex} at line ${scriptError.line}, column ${scriptError.column}: ${scriptError.message}. Offending line: ${scriptError.snippet}. Fix the script and call show_widget again.`,
        );
      }
      const widgetPath = readStringParam(params, "widget_path");
      const shouldPin = params.pin === true;
      const capabilities = normalizeBoardWidgetDeclared(
        params.capabilities as { netOrigins?: string[]; tools?: string[] } | undefined,
      );
      if (capabilities && !shouldPin) {
        throw new WidgetHtmlInputError("capabilities require pin=true");
      }
      const pinSessionKey = shouldPin ? options.agentSessionKey?.trim() : undefined;
      if (shouldPin && !pinSessionKey) {
        throw new WidgetHtmlInputError("pin requires an agent session");
      }
      const widgetCode = (
        await embedWidgetWorkspaceImages({
          widgetCode: rawWidgetCode,
          widgetPath,
          workspace: options.sandbox
            ? { root: options.sandbox.root, bridge: options.sandbox.bridge }
            : options.workspaceDir
              ? { root: options.workspaceDir }
              : undefined,
        })
      ).trim();
      assertWidgetHtmlSize(widgetCode, WIDGET_CODE_MAX_CHARS, {
        inputName: "widget_code after embedding local images; compress or resize images and retry",
        unit: "characters",
      });
      const wrappedDocument = buildWidgetDocument(title, widgetCode);
      let pinnedText = "";
      let pinnedWidgetName: string | undefined;
      if (pinSessionKey) {
        const sessionKey = pinSessionKey;
        const explicitName = readStringParam(params, "name");
        const name = explicitName ?? slugWidgetName(title);
        const tab = readStringParam(params, "tab");
        const size = readStringParam(params, "size");
        const presentation = readStringParam(params, "presentation");
        const after = readStringParam(params, "after");
        const pinnedTitle = boardWidgetTitle(title);
        assertPinnedWidgetDocumentSize(
          buildWidgetDocument(pinnedTitle ?? name, widgetCode, {
            connectOrigins: capabilities?.netOrigins,
          }),
        );
        const snapshot = await gatewayCall<BoardWidgetPutResult>("board.widget.put", {
          sessionKey,
          name,
          ...(pinnedTitle ? { title: pinnedTitle } : {}),
          // The Gateway owns the board document shell so agent-authored bytes
          // can never run before its user-activation and bridge bootstrap.
          content: { kind: "html", html: widgetCode },
          ...(presentation ? { presentation } : {}),
          ...(capabilities ? { declared: capabilities } : {}),
          ...(!explicitName ? { generatedIdentity: generatedWidgetIdentity(title, name) } : {}),
          ...(tab || size || after
            ? {
                placement: {
                  ...(tab ? { tabId: tab } : {}),
                  ...(size ? { size } : {}),
                  ...(after ? { after } : {}),
                },
              }
            : {}),
        });
        pinnedWidgetName = snapshot.resolvedWidgetName;
        const widget = snapshot.widgets.find(
          (candidate) => candidate.name === snapshot.resolvedWidgetName,
        );
        pinnedText = `; pinned to dashboard tab ${widget?.tabId ?? tab ?? "main"} as ${
          snapshot.resolvedWidgetName
        }${size ? ` (${size})` : ""}`;
      }
      // Pin first: placement validation can fail, and a rejected board write
      // must not materialize or prune the bounded inline-document store.
      const document = await createCanvasDocument(
        {
          kind: "html_bundle",
          title,
          entrypoint: { type: "html", value: wrappedDocument },
          surface: "assistant_message",
          retentionScope: resolveRetentionScope(options),
          ...(options.agentId?.trim() ? { ownerAgentId: options.agentId.trim() } : {}),
          // Direct navigation must not run widget script as the Control UI origin.
          cspSandbox: "scripts",
        },
        {
          stateDir: options.stateDir,
          maxDocumentsPerScope: WIDGET_MAX_PER_SCOPE,
        },
      );
      return jsonResult({
        kind: "canvas",
        presentation: { target: "assistant_message", title, sandbox: "scripts" },
        view: {
          id: document.id,
          url: document.entryUrl,
          ...(pinnedWidgetName ? { boardWidgetName: pinnedWidgetName } : {}),
        },
        text: `Widget hosted at ${document.entryUrl}${pinnedText}`,
      });
    },
  };
}
