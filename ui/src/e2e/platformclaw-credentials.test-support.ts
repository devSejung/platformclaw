import type { Page, Route } from "playwright";

type CredentialFixtureRow = {
  envName: string;
  definitionToken: string;
  credentialToken: string | null;
  configured: boolean;
  revision?: number;
  updatedAt?: number;
};

type CredentialFixtureMutation = {
  action: "add" | "replace" | "remove";
  envName: string;
  value?: string;
  expectedAccountId?: string;
  expectedDefinitionToken?: string;
  expectedCredentialToken?: string | null;
};

// Network fixtures enforce the browser contract; real encryption and SQLite
// concurrency are proven separately through the Control service tests.
export async function installCredentialApi(
  page: Page,
  options: { accountId: string; keys: readonly string[]; configured?: readonly string[] },
) {
  let sequence = 0;
  const definitions = new Map<string, CredentialFixtureRow>();
  const submissions: CredentialFixtureMutation[] = [];
  let unavailableNext = false;
  let deferred: { envName: string; promise: Promise<void> } | undefined;
  const add = (envName: string) => {
    definitions.set(envName, {
      envName,
      definitionToken: `definition-${++sequence}`,
      credentialToken: null,
      configured: false,
    });
  };
  const replace = (envName: string) => {
    const definition = definitions.get(envName)!;
    definition.configured = true;
    definition.revision = (definition.revision ?? 0) + 1;
    definition.credentialToken = `credential-${++sequence}`;
    definition.updatedAt = 1_700_000_000_000 + sequence;
    return { ...definition };
  };
  for (const key of options.keys) {
    add(key);
  }
  for (const key of options.configured ?? []) {
    replace(key);
  }
  const snapshot = () => ({
    accountId: options.accountId,
    definitions: [...definitions.values()]
      .toSorted((left, right) => left.envName.localeCompare(right.envName))
      .map((definition) => ({
        envName: definition.envName,
        definitionToken: definition.definitionToken,
        credentialToken: definition.credentialToken,
        configured: definition.configured,
        revision: definition.revision,
        updatedAt: definition.updatedAt,
      })),
  });
  const handle = async (route: Route, admin: boolean) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: snapshot() });
      return;
    }
    const body = route.request().postDataJSON() as CredentialFixtureMutation;
    submissions.push(body);
    if (deferred?.envName === body.envName) {
      const pending = deferred;
      deferred = undefined;
      await pending.promise;
    }
    if (body.expectedAccountId !== options.accountId) {
      await route.fulfill({ status: 409, json: { code: "credential-account-changed" } });
      return;
    }
    if (unavailableNext) {
      unavailableNext = false;
      await route.fulfill({ status: 503, json: { error: "Fixture unavailable" } });
      return;
    }
    const definition = definitions.get(body.envName);
    if (admin && body.action === "add") {
      if (!definition) {
        add(body.envName);
      }
      await route.fulfill({ json: snapshot() });
      return;
    }
    if (
      !definition ||
      body.expectedDefinitionToken !== definition.definitionToken ||
      (!admin && body.expectedCredentialToken !== definition.credentialToken)
    ) {
      await route.fulfill({ status: 409, json: { code: "credential-changed" } });
      return;
    }
    if (admin) {
      definitions.delete(body.envName);
      await route.fulfill({ json: snapshot() });
    } else if (body.action === "replace") {
      const updated = replace(body.envName);
      await route.fulfill({
        json: {
          envName: updated.envName,
          revision: updated.revision,
          definitionToken: updated.definitionToken,
          credentialToken: updated.credentialToken,
        },
      });
    } else {
      definition.configured = false;
      definition.credentialToken = null;
      delete definition.revision;
      delete definition.updatedAt;
      await route.fulfill({
        json: {
          deleted: true,
          envName: definition.envName,
          definitionToken: definition.definitionToken,
          credentialToken: null,
        },
      });
    }
  };
  await page.route("**/platformclaw/api/exec-credentials", (route) => handle(route, false));
  await page.route("**/platformclaw/api/admin/exec-credentials", (route) => handle(route, true));
  return {
    submissions,
    snapshot,
    replaceExternally: replace,
    failNextSave: () => {
      unavailableNext = true;
    },
    removeAllDefinitions: () => definitions.clear(),
    deferNextSave: (envName: string) => {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      deferred = { envName, promise };
      return release;
    },
  };
}
