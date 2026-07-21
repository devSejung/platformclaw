#!/usr/bin/env node
import { loadPlatformClawDeploymentConfig } from "./deployment-config.js";
import { createPlatformClawDeploymentRuntime } from "./deployment-runtime.js";

async function runPlatformClawControlServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadPlatformClawDeploymentConfig(env);
  const runtime = createPlatformClawDeploymentRuntime(config, { env });
  let closing: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  let rejectStopped: ((error: unknown) => void) | undefined;
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  const close = (): Promise<void> => {
    closing ??= runtime.close();
    return closing;
  };
  const onSignal = (): void => {
    void close().then(resolveStopped, rejectStopped);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const recovery = await runtime.prepare();
    console.log(
      `PlatformClaw restart recovery: found=${recovery.found} activated=${recovery.activated} failed=${recovery.failed} disabled=${recovery.disabled}`,
    );
    await runtime.listen({ host: config.listenHost, port: config.listenPort });
    console.log(`PlatformClaw control listening on ${config.publicOrigin}`);
    await stopped;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await close();
  }
}

runPlatformClawControlServer().catch((error: unknown) => {
  console.error("PlatformClaw control failed to start", error);
  process.exitCode = 1;
});
