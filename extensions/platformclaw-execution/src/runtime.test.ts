import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { disposeSshSandboxSession } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import {
  createMultiplexedSafeConnectSession,
  createSafeConnectSession,
  parseTarget,
  quoteOpenSshConfigPath,
} from "./runtime.js";

const TARGET: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person_one",
  targetId: "vm-one",
  revision: 9,
  allocationId: "allocation-one",
  credentialRevision: 3,
  vmLabel: "Development VM",
  safeConnectLabel: "Corporate access",
  remoteHomeDir: "/users/person.one",
  remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
  endpointHost: "safeconnect.example",
  endpointPort: 44422,
  adDomain: "example.com",
  adAccount: "person.one",
  targetAddress: "192.0.2.10",
  linuxAccount: "person.one",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "AAAA-approved-key",
  hostKeyFingerprint: "SHA256:approved",
};

describe("PlatformClaw SafeConnect session", () => {
  it("requires the assigned VM workspace to stay inside its canonical home", () => {
    expect(parseTarget(TARGET)).toMatchObject({
      remoteHomeDir: "/users/person.one",
      remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
    });
    expect(() => parseTarget({ ...TARGET, remoteWorkspaceDir: "/srv/shared/workspace" })).toThrow(
      "outside the remote home",
    );
    expect(() => parseTarget({ ...TARGET, remoteHomeDir: "/users/person.one/../other" })).toThrow(
      "remote home is invalid",
    );
    expect(() => parseTarget({ ...TARGET, credentialRevision: undefined })).toThrow(
      "credential revision is invalid",
    );
  });

  it("accepts bounded VM build environment and rejects launcher injection", () => {
    expect(
      parseTarget({
        ...TARGET,
        executionEnvironment: {
          pathPrepend: ["/opt/clang/bin"],
          variables: { TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-" },
        },
      }),
    ).toMatchObject({
      executionEnvironment: {
        pathPrepend: ["/opt/clang/bin"],
        variables: { TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-" },
      },
    });
    expect(() =>
      parseTarget({
        ...TARGET,
        executionEnvironment: { pathPrepend: [], variables: { LD_PRELOAD: "/tmp/bad.so" } },
      }),
    ).toThrow("LD_PRELOAD");
  });

  it("quotes whitespace and OpenSSH percent tokens in generated paths", () => {
    expect(quoteOpenSshConfigPath("/tmp/Person One/100%/known_hosts")).toBe(
      '"/tmp/Person One/100%%/known_hosts"',
    );
    expect(quoteOpenSshConfigPath(String.raw`C:\Users\Person One\known_hosts`)).toBe(
      String.raw`"C:\\Users\\Person One\\known_hosts"`,
    );
  });

  it("pins the approved endpoint key and stores no password", async () => {
    const session = await createSafeConnectSession(TARGET, "platformclaw-sshpass-test");
    try {
      const dir = path.dirname(session.configPath);
      const knownHostsPath = path.join(dir, "known_hosts");
      const [config, knownHosts, context] = await Promise.all([
        readFile(session.configPath, "utf8"),
        readFile(knownHostsPath, "utf8"),
        readFile(path.join(dir, "platformclaw-context.json"), "utf8"),
      ]);
      expect(session.command).toBe("platformclaw-sshpass-test");
      expect(config).toContain("PreferredAuthentications keyboard-interactive");
      expect(config).toContain("StrictHostKeyChecking yes");
      expect(config).toContain(`UserKnownHostsFile "${knownHostsPath.replaceAll("\\", "\\\\")}"`);
      expect(config).toContain("User example.com\\person.one+person.one+192.0.2.10");
      expect(knownHosts).toBe("[safeconnect.example]:44422 ssh-ed25519 AAAA-approved-key\n");
      expect(JSON.parse(context)).toEqual({
        agentId: "person_one",
        allocationId: "allocation-one",
        targetRevision: 9,
        credentialRevision: 3,
      });
      expect(context).not.toContain("password");
      expect(context).not.toContain("token");
    } finally {
      await disposeSshSandboxSession(session);
    }
  });

  it("rejects SSH config injection before opening a session", async () => {
    await expect(
      createSafeConnectSession({
        ...TARGET,
        endpointHost: "safeconnect.example ProxyCommand=bad",
      }),
    ).rejects.toThrow("endpoint host is invalid");
  });

  it("reuses only the pinned control socket and disables direct authentication fallback", async () => {
    const session = await createMultiplexedSafeConnectSession(TARGET, "/tmp/master/control.sock");
    try {
      const config = await readFile(session.configPath, "utf8");
      expect(session.command).toBe("ssh");
      expect(config).toContain('ControlPath "/tmp/master/control.sock"');
      expect(config).toContain("BatchMode yes");
      expect(config).toContain("KbdInteractiveAuthentication no");
      expect(config).toContain("PasswordAuthentication no");
      expect(config).toContain("PubkeyAuthentication no");
      expect(config).toContain("IdentityFile none");
      await expect(
        access(path.join(path.dirname(session.configPath), "platformclaw-context.json")),
      ).rejects.toThrow();
    } finally {
      await disposeSshSandboxSession(session);
    }
  });

  it("passes only an anonymous one-shot grant to a connection-test launcher", async () => {
    const session = await createSafeConnectSession(TARGET, "platformclaw-sshpass-test", {
      credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
      credentialGrantToken: "grant_token_123456789012345678901234567890",
    });
    try {
      const context = JSON.parse(
        await readFile(
          path.join(path.dirname(session.configPath), "platformclaw-context.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(context).toMatchObject({
        agentId: "person_one",
        credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
        credentialGrantToken: "grant_token_123456789012345678901234567890",
      });
      expect(JSON.stringify(context)).not.toContain("password");
    } finally {
      await disposeSshSandboxSession(session);
    }
  });
});
