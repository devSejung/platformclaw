// Codex tests cover attempt context plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexWorkspaceBootstrapContext,
  buildCodexSystemPromptReport,
  getCodexAvailableToolNames,
  getCodexWorkspaceMemoryToolNames,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import type { CodexAppServerContextEngineBinding } from "./session-binding.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

describe("Codex app-server attempt context", () => {
  it("treats missing mirrored session history as empty without hook warning", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-attempt-context-history-"));
    const sessionFile = path.join(dir, "session.jsonl");
    try {
      await expect(
        readMirroredSessionHistoryMessages({
          sessionFile,
          sessionId: "codex-session",
          sessionKey: "codex-session",
        }),
      ).resolves.toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a run context report without deferred Codex dynamic tool schemas", () => {
    const tools = [
      {
        type: "function",
        name: "message",
        description: "Send a message.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      },
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
            deferLoading: true,
          },
        ],
      },
    ] as CodexDynamicToolSpec[];

    const report = buildCodexSystemPromptReport({
      attempt: {
        sessionId: "session-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
      } as EmbeddedRunAttemptParams,
      sessionKey: "agent:main:session-1",
      workspaceDir: path.join("tmp", "workspace"),
      developerInstructions: "test developer instructions",
      workspaceBootstrapContext: {
        bootstrapFiles: [],
        contextFiles: [],
        promptContextFiles: [],
      },
      skillsPrompt: "",
      tools,
    });

    expect(report.source).toBe("run");
    expect(report.provider).toBe("codex");
    expect(report.model).toBe("gpt-5.4-codex");
    expect(report.systemPrompt.chars).toBeGreaterThan(0);
    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);

    const message = report.tools.entries.find((tool) => tool.name === "message");
    const webSearch = report.tools.entries.find((tool) => tool.name === "web_search");
    expect(message?.schemaChars).toBeGreaterThan(0);
    expect(message?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(message?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaChars).toBe(0);
    expect(webSearch?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.schemaChars).toBe(message?.schemaChars);
  });

  it("keeps MEMORY.md injected when sandbox effective workspace differs", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-memory-workspace-"));
    const sandboxWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-memory-sandbox-"));
    const memorySummary = "Sandboxed turns need bounded memory fallback.";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);

    const context = await buildCodexWorkspaceBootstrapContext({
      params: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        },
      } as EmbeddedRunAttemptParams,
      resolvedWorkspace: workspaceDir,
      effectiveWorkspace: sandboxWorkspaceDir,
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      memoryToolNames: ["memory_search", "memory_get"],
      availableToolNames: ["memory_search", "memory_get"],
    });

    expect(context.memoryReferenceFiles).toEqual([]);
    expect(context.promptContext).toContain(memorySummary);
    expect(context.memoryToolRouted).toBe(false);
  });

  it("uses native project instructions and Gateway memory tools for a split workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-split-workspace-"));
    const sandboxWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-split-project-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "gateway project policy");
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "gateway memory");
      await fs.writeFile(path.join(workspaceDir, "USER.md"), "gateway user profile");
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: sandboxWorkspaceDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        memoryToolNames: ["memory_search", "memory_get", "memory_write"],
        availableToolNames: ["memory_search", "memory_get", "memory_write"],
        sandboxed: true,
        nativeProjectInstructions: true,
      });

      expect(context.bootstrapFiles.map((file) => file.name)).not.toContain("AGENTS.md");
      expect(context.promptContext ?? "").not.toContain("gateway project policy");
      expect(context.promptContext ?? "").not.toContain("gateway memory");
      expect(context.turnScopedDeveloperInstructions).toContain("gateway user profile");
      expect(context.turnScopedDeveloperInstructions).toContain("agent_workspace_read");
      expect(context.memoryToolRouted).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(sandboxWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("passes agent context to Codex memory collaboration guidance", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-memory-"));
    let observedContext:
      | { agentId?: string; agentSessionKey?: string; sandboxed?: boolean }
      | undefined;
    registerMemoryCapability("memory-core", {
      promptBuilder: (context) => {
        observedContext = context;
        return [
          "## Agent Memory",
          `agent=${context.agentId} session=${context.agentSessionKey}`,
          "",
        ];
      },
    });

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:marketing-agent:session-1",
          config: {
            agents: {
              defaults: { workspace: workspaceDir },
              list: [{ id: "marketing-agent", default: true, workspace: workspaceDir }],
            },
          },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:marketing-agent:session-1",
        sessionAgentId: "marketing-agent",
        memoryToolNames: ["memory_search", "memory_get"],
        availableToolNames: ["memory_search", "memory_get"],
        sandboxed: true,
      });

      expect(context.memoryToolRouted).toBe(true);
      expect(observedContext).toMatchObject({
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:session-1",
        sandboxed: true,
      });
      expect(context.memoryCollaborationInstructions).toContain(
        "agent=marketing-agent session=agent:marketing-agent:session-1",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("routes deferred wiki tools into memory collaboration guidance", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-wiki-memory-"));
    registerMemoryCapability("memory-wiki-test", {
      promptBuilder: ({ availableTools }) =>
        availableTools.has("wiki_search") && availableTools.has("wiki_apply")
          ? ["## Compiled Wiki", "Use `wiki_search` before `wiki_apply`.", ""]
          : [],
    });
    const dynamicTools: CodexDynamicToolSpec[] = [
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "wiki_search",
            description: "Search wiki",
            inputSchema: { type: "object", properties: {} },
            deferLoading: true,
          },
          {
            type: "function",
            name: "wiki_apply",
            description: "Update wiki",
            inputSchema: { type: "object", properties: {} },
            deferLoading: true,
          },
        ],
      },
    ];
    const memoryToolNames = getCodexWorkspaceMemoryToolNames(dynamicTools);
    const availableToolNames = getCodexAvailableToolNames(dynamicTools);

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        memoryToolNames,
        availableToolNames,
      });

      expect(memoryToolNames).toEqual([]);
      expect(availableToolNames).toEqual(["wiki_search", "wiki_apply"]);
      expect(context.memoryToolRouted).toBe(false);
      expect(context.memoryCollaborationInstructions).toContain("## Compiled Wiki");
      expect(context.memoryCollaborationInstructions).toContain(
        "Codex may expose these memory-guidance tools as deferred: wiki_apply, wiki_search.",
      );
      expect(context.memoryCollaborationInstructions).toContain(
        "Before using a shell, CLI, or direct filesystem edit",
      );
      expect(context.memoryCollaborationInstructions).toContain(
        "use `tool_search` to load the exact named tool",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reads and compares thread-bootstrap context-engine projections", () => {
    const projection = readContextEngineThreadBootstrapProjection({
      mode: "thread_bootstrap",
      epoch: " epoch-1 ",
      fingerprint: " fingerprint-1 ",
    });
    expect(projection).toEqual({
      mode: "thread_bootstrap",
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    });

    const expectedBinding = {
      schemaVersion: 1,
      engineId: "lossless",
      policyFingerprint: "policy-v1",
      projection: {
        schemaVersion: 1,
        mode: "thread_bootstrap",
        epoch: "epoch-1",
        fingerprint: "fingerprint-1",
      },
    } satisfies CodexAppServerContextEngineBinding;
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "same-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "same-tools",
      }),
    ).toEqual({
      project: false,
      reason: "matching-thread-bootstrap-binding",
    });
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "old-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "new-tools",
      }),
    ).toEqual({
      project: true,
      reason: "dynamic-tools-mismatch",
    });
  });

  it("stitches watched-session context into the per-turn OpenClaw prompt context", () => {
    const attempt = { config: {} } as EmbeddedRunAttemptParams;

    expect(
      buildCodexOpenClawPromptContext({
        params: attempt,
        watchedSessionsContext: [
          "## Watched Sessions",
          "- agent:main:telegram:group:beta — Family group",
        ].join("\n"),
      }),
    ).toContain("## Watched Sessions");

    // No ambient watches (and no state) must render nothing, not an empty section.
    expect(
      buildCodexWatchedSessionsContext({
        attempt,
        dynamicTools: [
          {
            type: "function",
            name: "sessions_history",
            description: "history",
            inputSchema: {},
          },
        ],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);

    // Lightweight cron turns keep the runtime context byte-for-byte untouched.
    expect(
      buildCodexWatchedSessionsContext({
        attempt: {
          config: {},
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "cron",
        } as EmbeddedRunAttemptParams,
        dynamicTools: [],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);
  });
});
