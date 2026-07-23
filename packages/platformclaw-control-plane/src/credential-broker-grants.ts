import { createHash, randomBytes } from "node:crypto";
import { ControlPlaneStateError } from "./contracts.js";
import type { ResolvedUserSshCredential } from "./ssh-credential-vault.js";

const DEFAULT_GRANT_TTL_MS = 30_000;
const DEFAULT_MAX_PENDING_GRANTS = 256;

export type CredentialBrokerGrant = {
  token: string;
  expiresAt: number;
};

export type CredentialBrokerGrantResolver = () => Promise<ResolvedUserSshCredential>;

type PendingGrant = {
  expiresAt: number;
  resolve: CredentialBrokerGrantResolver;
};

export type OneShotCredentialGrantStoreOptions = {
  now?: () => number;
  tokenFactory?: () => string;
  ttlMs?: number;
  maxPendingGrants?: number;
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export class OneShotCredentialGrantStore {
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly ttlMs: number;
  private readonly maxPendingGrants: number;
  private readonly pending = new Map<string, PendingGrant>();

  constructor(options: OneShotCredentialGrantStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.ttlMs = options.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    this.maxPendingGrants = options.maxPendingGrants ?? DEFAULT_MAX_PENDING_GRANTS;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 120_000) {
      throw new ControlPlaneStateError("credential grant TTL must be 1000 to 120000 milliseconds");
    }
    if (
      !Number.isInteger(this.maxPendingGrants) ||
      this.maxPendingGrants < 1 ||
      this.maxPendingGrants > 4_096
    ) {
      throw new ControlPlaneStateError("max pending credential grants must be 1 to 4096");
    }
  }

  issue(resolve: CredentialBrokerGrantResolver): CredentialBrokerGrant {
    const now = this.now();
    this.pruneExpired(now);
    if (this.pending.size >= this.maxPendingGrants) {
      throw new ControlPlaneStateError("credential grant capacity reached");
    }
    const token = this.tokenFactory();
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
      throw new ControlPlaneStateError("credential grant token is invalid");
    }
    const hash = tokenHash(token);
    if (this.pending.has(hash)) {
      throw new ControlPlaneStateError("credential grant token collision");
    }
    const expiresAt = now + this.ttlMs;
    this.pending.set(hash, { expiresAt, resolve });
    return { token, expiresAt };
  }

  async redeem(token: string): Promise<ResolvedUserSshCredential> {
    const hash = tokenHash(token);
    const grant = this.pending.get(hash);
    if (!grant) {
      throw new ControlPlaneStateError("credential grant is invalid or already used");
    }
    // Consume before resolving. Resolver failure must not make a bearer token reusable.
    this.pending.delete(hash);
    if (grant.expiresAt <= this.now()) {
      throw new ControlPlaneStateError("credential grant is invalid or expired");
    }
    const resolved = await grant.resolve();
    if (!Buffer.isBuffer(resolved.password)) {
      throw new ControlPlaneStateError("credential grant resolver returned invalid bytes");
    }
    if (resolved.password.length === 0) {
      resolved.password.fill(0);
      throw new ControlPlaneStateError("credential grant resolver returned invalid bytes");
    }
    if (!Number.isInteger(resolved.revision) || resolved.revision < 1) {
      resolved.password.fill(0);
      throw new ControlPlaneStateError("credential grant resolver returned invalid revision");
    }
    return resolved;
  }

  revoke(token: string): boolean {
    return this.pending.delete(tokenHash(token));
  }

  clear(): void {
    this.pending.clear();
  }

  private pruneExpired(now: number): void {
    for (const [hash, grant] of this.pending) {
      if (grant.expiresAt <= now) {
        this.pending.delete(hash);
      }
    }
  }
}
