import { BrowserAuthService, type PersonalAgentProvisioner } from "./browser-auth-service.js";
import type { MainSessionKeyBuilder } from "./contracts.js";
import {
  HttpEmployeeAuthenticator,
  loadEmployeeAuthClientConfig,
  type EmployeeAuthClientConfig,
} from "./employee-auth-client.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

export type EmployeeBrowserAuthRuntimeOptions = {
  databasePath: string;
  buildAgentMainSessionKey: MainSessionKeyBuilder;
  provisioner: PersonalAgentProvisioner;
  initialAdminAccountIds: readonly string[];
  employeeAuthConfig?: EmployeeAuthClientConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  tokenFactory?: () => string;
};

export type EmployeeBrowserAuthRuntime = {
  store: SqliteControlPlaneStore;
  service: BrowserAuthService;
  close(): void;
};

/** Build the production LDAP-phase browser-auth runtime around the persistent store. */
export function createEmployeeBrowserAuthRuntime(
  options: EmployeeBrowserAuthRuntimeOptions,
): EmployeeBrowserAuthRuntime {
  const authConfig = options.employeeAuthConfig ?? loadEmployeeAuthClientConfig(options.env);
  const authenticator = new HttpEmployeeAuthenticator(
    authConfig,
    options.fetchImpl ?? globalThis.fetch,
  );
  const store = new SqliteControlPlaneStore({
    databasePath: options.databasePath,
    buildAgentMainSessionKey: options.buildAgentMainSessionKey,
    initialAdminAccountIds: options.initialAdminAccountIds,
  });
  const service = new BrowserAuthService({
    store,
    authenticator,
    provisioner: options.provisioner,
    ...(options.now ? { now: options.now } : {}),
    ...(options.tokenFactory ? { tokenFactory: options.tokenFactory } : {}),
  });
  let closed = false;
  return {
    store,
    service,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      store.close();
    },
  };
}
