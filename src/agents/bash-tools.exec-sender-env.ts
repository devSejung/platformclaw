export function applyTrustedSenderEnv(env: Record<string, string>, senderId?: string | null): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "SENDER_ID") {
      delete env[key];
    }
  }
  const normalizedSenderId = senderId?.trim();
  if (normalizedSenderId) {
    env.SENDER_ID = normalizedSenderId;
  }
}
