import type { ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  CLAUDE_GATEWAY_ENVIRONMENT_KEYS,
  type CodingAgentConfiguration,
  type CodingAgentId,
  type CodingAgentProbeResult,
} from "@platformclaw/coding-agent-contract";
import type { AcpProcessTransportLaunch } from "openclaw/plugin-sdk/acp-runtime-backend";
import {
  buildRemoteCommand,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { AssignedVmTargetSnapshot } from "./backend.js";

const PROBE_TIMEOUT_MS = 15_000;
const ACP_TIMEOUT_MS = 90_000;
const AUTH_REQUIRED_ERROR_CODE = RequestError.authRequired().code;
const AGENT_COMMANDS: Record<CodingAgentId, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
};

type ProbeDependencies = {
  createSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>;
  launch: (
    input: AcpProcessTransportLaunch,
    target: Readonly<AssignedVmTargetSnapshot>,
  ) => Promise<ChildProcessByStdio<Writable, Readable, Readable>>;
};

function skipped(agent: CodingAgentId): CodingAgentProbeResult {
  return {
    agent,
    diagnostics: [
      {
        stage: "executable",
        status: "failed",
        message: `${agent} was not found in the VM user shell.`,
      },
      {
        stage: "helper",
        status: "skipped",
        message: "Authentication was not checked because the executable was not found.",
      },
      {
        stage: "acp",
        status: "skipped",
        message: "ACP was not checked because the executable was not found.",
      },
    ],
  };
}

export async function detectAssignedVmCodingAgent(params: {
  target: AssignedVmTargetSnapshot;
  agent: CodingAgentId;
  createSession: ProbeDependencies["createSession"];
}): Promise<CodingAgentProbeResult> {
  const session = await params.createSession(params.target);
  const marker = `PLATFORMCLAW_${randomBytes(12).toString("hex")}`;
  const environmentNames =
    params.agent === "claude" ? CLAUDE_GATEWAY_ENVIRONMENT_KEYS.join(" ") : "";
  const script = [
    `candidate=$(command -v ${AGENT_COMMANDS[params.agent]} 2>/dev/null || true)`,
    'version=""',
    'case "$candidate" in /*) ;; *) candidate="" ;; esac',
    'if [ -n "$candidate" ] && [ -x "$candidate" ]; then version=$("$candidate" --version 2>/dev/null | head -c 512 || true); else candidate=""; fi',
    `printf '\\n${marker}\\n'`,
    'printf "path=%s\\n" "$(printf %s "$candidate" | base64 -w0)"',
    'printf "version=%s\\n" "$(printf %s "$version" | base64 -w0)"',
    `for name in ${environmentNames}; do value=$(printenv "$name" 2>/dev/null || true); printf 'env.%s=%s\\n' "$name" "$(printf %s "$value" | base64 -w0)"; done`,
    `printf '${marker}_END\\n'`,
  ].join("; ");
  try {
    const result = await runSshSandboxCommand({
      session,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'shell=$(getent passwd "$(id -u)" | cut -d: -f7); case "${shell##*/}" in bash|zsh|sh) ;; *) echo "Unsupported VM user shell" >&2; exit 125;; esac; exec "$shell" -lic "$1"',
        "platformclaw-coding-agent-detect",
        script,
      ]),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      maxBufferBytes: 64 * 1024,
    });
    const stdout = result.stdout.toString("utf8");
    const start = stdout.lastIndexOf(`${marker}\n`);
    const end = stdout.indexOf(`${marker}_END`, start + marker.length);
    if (start < 0 || end < 0) {
      throw new Error("coding agent shell probe returned no structured result");
    }
    const values = new Map(
      stdout
        .slice(start + marker.length + 1, end)
        .split(/\r?\n/u)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const decode = (key: string) => Buffer.from(values.get(key) ?? "", "base64").toString("utf8");
    const executablePath = decode("path");
    const environment =
      params.agent === "claude"
        ? Object.fromEntries(
            CLAUDE_GATEWAY_ENVIRONMENT_KEYS.map((key) => [key, decode(`env.${key}`)]),
          )
        : undefined;
    if (!executablePath) {
      return { ...skipped(params.agent), ...(environment ? { environment } : {}) };
    }
    const reportedVersion = decode("version");
    return {
      agent: params.agent,
      executablePath,
      ...(reportedVersion ? { reportedVersion } : {}),
      ...(params.agent === "claude"
        ? {
            environment,
          }
        : {}),
      diagnostics: [
        {
          stage: "executable",
          status: "passed",
          message: `${params.agent} was found in the VM user shell.`,
        },
        {
          stage: "helper",
          status: "skipped",
          message: "Authentication is checked only by the explicit ACP check.",
        },
        {
          stage: "acp",
          status: "skipped",
          message: "ACP is checked only by the explicit ACP check.",
        },
      ],
    };
  } finally {
    await disposeSshSandboxSession(session).catch(() => {});
  }
}

function withConfiguration(
  target: AssignedVmTargetSnapshot,
  configuration: CodingAgentConfiguration,
): AssignedVmTargetSnapshot {
  return {
    ...target,
    codingAgents: target.codingAgents.map((entry) =>
      entry.agent === configuration.agent ? configuration : entry,
    ),
  };
}

function looksLikeAuthenticationFailure(error: unknown): boolean {
  return error instanceof RequestError && error.code === AUTH_REQUIRED_ERROR_CODE;
}

function boundReadable(input: Readable, maxBytes: number): Readable {
  let bytes = 0;
  return input.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes <= maxBytes ? undefined : new Error("ACP output exceeded the limit"), chunk);
      },
    }),
  );
}

async function stopChild(child: ChildProcessByStdio<Writable, Readable, Readable>): Promise<void> {
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    timer = undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function boundedCleanup(operation: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    operation().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1_000);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

function acpFailureMessage(error: unknown): string {
  const failure = error as { stage?: unknown; code?: unknown };
  if (failure.stage === "adapter" && failure.code === "adapter_missing") {
    return "The assigned VM ACP adapter is not installed. Install the packaged adapter bundle, then retry.";
  }
  if (failure.stage === "adapter" && failure.code === "agent_executable_missing") {
    return "The configured coding agent executable was not found. Detect it again or update its path.";
  }
  if (error instanceof Error && error.message === "ACP check timed out") {
    return "ACP timed out before completing the validation response. Check the VM agent and retry.";
  }
  if (error instanceof RequestError) {
    return `ACP returned a protocol error (${String(error.code)}). Check the coding agent authentication and adapter.`;
  }
  return "ACP initialization or response failed. Check the VM installation and authentication, then retry.";
}

export async function checkAssignedVmCodingAgent(params: {
  target: AssignedVmTargetSnapshot;
  configuration: CodingAgentConfiguration;
  launch: ProbeDependencies["launch"];
}): Promise<CodingAgentProbeResult> {
  const target = withConfiguration(params.target, params.configuration);
  const agent = params.configuration.agent;
  if (!params.configuration.executablePath) {
    return skipped(agent);
  }
  let child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  let connection: ClientSideConnection | undefined;
  let sessionId: string | undefined;
  let responseText = "";
  let timeout: NodeJS.Timeout | undefined;
  try {
    child = await params.launch(
      {
        executionOwnerAgentId: target.agentId,
        agent,
        sessionKey: `coding-agent-check-${randomBytes(8).toString("hex")}`,
        command: "",
        args: [],
        cwd: target.remoteWorkspaceDir,
        env: {},
      },
      target,
    );
    child.stderr.resume();
    connection = new ClientSideConnection(
      () => ({
        requestPermission: () => ({ outcome: { outcome: "cancelled" as const } }),
        sessionUpdate: (notification: SessionNotification) => {
          const update = notification.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            responseText = `${responseText}${update.content.text}`.slice(0, 4096);
          }
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        // Node and DOM publish distinct structural stream declarations even though
        // this adapter produces the byte stream required by ACP.
        Readable.toWeb(boundReadable(child.stdout, 1024 * 1024)) as unknown as ReadableStream<
          Uint8Array
        >,
      ),
    );
    const expectedResponse = `ACP_OK_${randomBytes(12).toString("hex")}`;
    const exchange = async () => {
      await connection!.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "platformclaw-coding-agent-check", version: "1" },
      });
      const created = await connection!.newSession({
        cwd: target.remoteWorkspaceDir,
        mcpServers: [],
        ...(agent === "claude"
          ? { _meta: { claudeCode: { options: { settingSources: ["user", "project", "local"] } } } }
          : {}),
      });
      sessionId = created.sessionId;
      const prompt = await connection!.prompt({
        sessionId: created.sessionId,
        prompt: [
          { type: "text", text: `Reply with exactly ${expectedResponse}. Do not use tools.` },
        ],
      });
      if (prompt.stopReason !== "end_turn") {
        throw new Error("ACP validation turn did not complete");
      }
    };
    await Promise.race([
      exchange(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("ACP check timed out")), ACP_TIMEOUT_MS);
      }),
    ]);
    const ok = responseText.trim() === expectedResponse;
    return {
      agent,
      executablePath: params.configuration.executablePath,
      diagnostics: [
        {
          stage: "executable",
          status: "passed",
          message: `${agent} executable and ACP adapter started.`,
        },
        {
          stage: "helper",
          status: "skipped",
          message:
            agent === "claude"
              ? "Claude authenticated for ACP; apiKeyHelper invocation is not separately exposed by the adapter."
              : `${agent} does not use the Claude gateway helper.`,
        },
        {
          stage: "acp",
          status: ok ? "passed" : "failed",
          message: ok
            ? "ACP returned the expected validation response."
            : "ACP responded, but not with the expected validation response.",
        },
      ],
    };
  } catch (error) {
    const auth = agent === "claude" && looksLikeAuthenticationFailure(error);
    return {
      agent,
      executablePath: params.configuration.executablePath,
      diagnostics: [
        {
          stage: "executable",
          status: child ? "passed" : "failed",
          message: child
            ? `${agent} executable and ACP adapter launch prerequisites passed.`
            : `${agent} executable or ACP adapter could not start.`,
        },
        {
          stage: "helper",
          status: auth ? "failed" : "skipped",
          message: auth
            ? "Claude gateway authentication failed. Sign in again with gateway-cli in the VM, then retry."
            : "Authentication could not be confirmed because ACP failed before a response.",
        },
        {
          stage: "acp",
          status: "failed",
          message: acpFailureMessage(error),
        },
      ],
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (connection && sessionId) {
      await boundedCleanup(async () => await connection!.cancel({ sessionId: sessionId! }));
      await boundedCleanup(async () => await connection!.closeSession({ sessionId: sessionId! }));
    }
    if (child) {
      await stopChild(child);
    }
  }
}
