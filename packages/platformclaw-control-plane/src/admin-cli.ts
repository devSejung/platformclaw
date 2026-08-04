import { SqliteControlPlaneStore } from "./sqlite-store.js";

export type PlatformClawAdminCliOptions = {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  write?: (message: string) => void;
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function runPlatformClawAdminCli(options: PlatformClawAdminCliOptions): Promise<void> {
  const [command, accountId, ...rest] = options.argv;
  if (command !== "add" || !accountId || rest.length > 0) {
    throw new Error("usage: platformclaw-admin add <account-id>");
  }
  const store = new SqliteControlPlaneStore({
    databasePath: requiredEnv(options.env ?? process.env, "PLATFORMCLAW_DATABASE_PATH"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  try {
    const result = await store.addDeploymentAdministrator({
      accountId,
      changedAt: (options.now ?? Date.now)(),
    });
    (options.write ?? ((message) => process.stdout.write(message)))(
      result.changed
        ? `PlatformClaw administrator added: ${result.user.accountId}\n`
        : `PlatformClaw administrator already exists: ${result.user.accountId}\n`,
    );
  } finally {
    store.close();
  }
}
