export class PlatformClawVmAuthenticationError extends Error {
  constructor() {
    super("development VM authentication failed");
    this.name = "PlatformClawVmAuthenticationError";
  }
}
