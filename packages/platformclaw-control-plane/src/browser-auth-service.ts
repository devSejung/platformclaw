import { createHash, randomBytes } from "node:crypto";
import type {
  BrowserSession,
  BrowserSessionResolution,
  ControlPlaneStore,
  PersonalAgentBinding,
  PlatformUser,
} from "./contracts.js";
import type {
  EmployeeAuthenticator,
  EmployeeAuthRequestContext,
  EmployeeDirectoryProfile,
  EmployeePasswordCredentials,
} from "./employee-auth-client.js";

export type PersonalAgentProvisioningRequest = {
  user: PlatformUser;
  binding: PersonalAgentBinding;
  profile: EmployeeDirectoryProfile;
  createdBinding: boolean;
};

export interface PersonalAgentProvisioner {
  provisionOrRefresh(request: PersonalAgentProvisioningRequest): Promise<void>;
}

export type BrowserLoginResult =
  | {
      status: "authenticated";
      token: string;
      session: BrowserSession;
      user: PlatformUser;
      binding: PersonalAgentBinding;
      createdUser: boolean;
      createdBinding: boolean;
    }
  | { status: "rejected"; message: string }
  | { status: "auth-unavailable"; message: string }
  | { status: "account-disabled" }
  | { status: "session-limit"; activeSessionCount: number }
  | { status: "provisioning-failed"; message: string };

export type BrowserAuthenticationResult =
  | Exclude<BrowserSessionResolution, { status: "revoked" | "expired" | "user-disabled" }>
  | { status: "unauthenticated"; reason: "revoked" | "expired" | "user-disabled" };

function defaultTokenFactory(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBrowserSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class BrowserAuthService {
  private readonly provisioningByBindingId = new Map<string, Promise<PersonalAgentBinding>>();

  constructor(
    private readonly options: {
      store: ControlPlaneStore;
      authenticator: EmployeeAuthenticator;
      provisioner: PersonalAgentProvisioner;
      now?: () => number;
      tokenFactory?: () => string;
    },
  ) {}

  async loginPassword(params: {
    login: EmployeePasswordCredentials;
    context?: EmployeeAuthRequestContext;
    currentSession?: { value: string };
  }): Promise<BrowserLoginResult> {
    const auth = await this.options.authenticator.authenticatePassword({
      login: params.login,
      context: params.context ?? {},
    });
    if (auth.status === "rejected") {
      return auth;
    }
    if (auth.status === "unavailable") {
      return { status: "auth-unavailable", message: auth.message };
    }

    // Version directory data by completed authentication order, not request start order.
    const authenticatedAt = (this.options.now ?? Date.now)();
    const upserted = await this.options.store.upsertPrincipal(auth.principal, authenticatedAt);
    if (upserted.user.status !== "active") {
      return { status: "account-disabled" };
    }
    const reservation = await this.options.store.reservePersonalAgent(
      upserted.user.id,
      authenticatedAt,
    );
    if (reservation.binding.state === "disabled") {
      return { status: "account-disabled" };
    }
    let binding: PersonalAgentBinding;
    try {
      binding = await this.provisionPersonalAgent({
        user: upserted.user,
        binding: reservation.binding,
        profile: auth.profile,
        createdBinding: reservation.created,
        changedAt: authenticatedAt,
      });
    } catch (error) {
      return {
        status: "provisioning-failed",
        message: error instanceof Error ? error.message : "personal agent provisioning failed",
      };
    }

    const sessionAt = (this.options.now ?? Date.now)();
    const currentSession = params.currentSession
      ? await this.options.store.resolveBrowserSession({
          tokenHash: hashBrowserSessionToken(params.currentSession.value),
          resolvedAt: sessionAt,
          touch: true,
        })
      : undefined;
    if (currentSession?.status === "active" && currentSession.user.id === upserted.user.id) {
      return {
        status: "authenticated",
        token: params.currentSession.value,
        session: currentSession.session,
        user: upserted.user,
        binding,
        createdUser: upserted.createdUser,
        createdBinding: reservation.created,
      };
    }

    const token = (this.options.tokenFactory ?? defaultTokenFactory)();
    if (!token) {
      throw new Error("browser session token factory returned an empty token");
    }
    const created = await this.options.store.createBrowserSession({
      userId: upserted.user.id,
      tokenHash: hashBrowserSessionToken(token),
      createdAt: sessionAt,
    });
    if (created.status === "limit-reached") {
      return { status: "session-limit", activeSessionCount: created.activeSessionCount };
    }
    if (currentSession?.status === "active") {
      await this.options.store.revokeBrowserSession(currentSession.session.id, sessionAt);
    }
    return {
      status: "authenticated",
      token,
      session: created.session,
      user: upserted.user,
      binding,
      createdUser: upserted.createdUser,
      createdBinding: reservation.created,
    };
  }

  private provisionPersonalAgent(params: PersonalAgentProvisioningRequest & { changedAt: number }) {
    const existing = this.provisioningByBindingId.get(params.binding.id);
    if (existing) {
      // Preserve authenticated profile order while the initial workspace creation is in flight.
      // A later login refreshes after the earlier write instead of dropping newer metadata.
      const refresh = existing.then(async (binding) => {
        await this.options.provisioner.provisionOrRefresh({
          ...params,
          binding,
          createdBinding: false,
        });
        return binding;
      });
      this.trackProvisioning(params.binding.id, refresh);
      return refresh;
    }
    // platformclaw-control is one process in phase 1. This single-flight prevents two
    // logins in that process from racing the binding state machine and workspace writes.
    const task = this.runPersonalAgentProvisioning(params);
    this.trackProvisioning(params.binding.id, task);
    return task;
  }

  private trackProvisioning(bindingId: string, task: Promise<PersonalAgentBinding>): void {
    this.provisioningByBindingId.set(bindingId, task);
    const cleanup = () => {
      if (this.provisioningByBindingId.get(bindingId) === task) {
        this.provisioningByBindingId.delete(bindingId);
      }
    };
    void task.then(cleanup, cleanup);
  }

  private async runPersonalAgentProvisioning(
    params: PersonalAgentProvisioningRequest & { changedAt: number },
  ): Promise<PersonalAgentBinding> {
    let binding = params.binding;
    if (binding.state === "failed") {
      const transitioned = await this.options.store.transitionAgent({
        bindingId: binding.id,
        state: "provisioning",
        changedAt: params.changedAt,
      });
      if (transitioned.kind !== "personal") {
        throw new Error("personal agent reservation changed kind");
      }
      binding = transitioned;
    }
    try {
      await this.options.provisioner.provisionOrRefresh({ ...params, binding });
      if (binding.state !== "provisioning") {
        return binding;
      }
      const transitioned = await this.options.store.transitionAgent({
        bindingId: binding.id,
        state: "active",
        changedAt: params.changedAt,
      });
      if (transitioned.kind !== "personal") {
        throw new Error("personal agent reservation changed kind");
      }
      return transitioned;
    } catch (error) {
      if (binding.state === "provisioning") {
        await this.options.store.transitionAgent({
          bindingId: binding.id,
          state: "failed",
          changedAt: params.changedAt,
          failureCode: "provisioner_error",
        });
      }
      throw error;
    }
  }

  async authenticateToken(token: string, touch = true): Promise<BrowserAuthenticationResult> {
    if (!token) {
      return { status: "unauthenticated", reason: "expired" };
    }
    const result = await this.options.store.resolveBrowserSession({
      tokenHash: hashBrowserSessionToken(token),
      resolvedAt: (this.options.now ?? Date.now)(),
      touch,
    });
    if (
      result.status === "revoked" ||
      result.status === "expired" ||
      result.status === "user-disabled"
    ) {
      return {
        status: "unauthenticated",
        reason: result.status === "user-disabled" ? "user-disabled" : result.status,
      };
    }
    return result;
  }

  async logout(token: string): Promise<boolean> {
    const resolution = await this.options.store.resolveBrowserSession({
      tokenHash: hashBrowserSessionToken(token),
      resolvedAt: (this.options.now ?? Date.now)(),
      touch: false,
    });
    if (resolution.status !== "active") {
      return false;
    }
    return Boolean(
      await this.options.store.revokeBrowserSession(
        resolution.session.id,
        (this.options.now ?? Date.now)(),
      ),
    );
  }
}
