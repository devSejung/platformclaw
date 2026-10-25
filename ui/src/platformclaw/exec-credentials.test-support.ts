import { expect, vi } from "vitest";
import type { PlatformClawExecCredentialsElement } from "./exec-credentials.ts";
import "./exec-credentials.ts";

type CredentialElement = PlatformClawExecCredentialsElement;

type MetadataFixture = {
  envName: string;
  configured?: boolean;
  revision?: number;
  definitionToken?: string;
  credentialToken?: string | null;
};
function metadata(item: MetadataFixture) {
  return {
    ...item,
    definitionToken: item.definitionToken ?? `definition-${item.envName}`,
    configured: item.configured === true,
    credentialToken:
      item.credentialToken === undefined
        ? item.configured
          ? `credential-${item.envName}-${item.revision ?? 1}`
          : null
        : item.credentialToken,
  };
}
export function response(body: unknown, status = 200): Response {
  const fixture = body as {
    definitions?: MetadataFixture[];
    envName?: string;
    revision?: number;
    definitionToken?: string;
    credentialToken?: string;
  };
  const payload = fixture.definitions
    ? { ...fixture, definitions: fixture.definitions.map(metadata) }
    : fixture.envName && fixture.revision !== undefined
      ? {
          ...fixture,
          definitionToken: fixture.definitionToken ?? `definition-${fixture.envName}`,
          credentialToken:
            fixture.credentialToken ?? `credential-${fixture.envName}-${fixture.revision}`,
        }
      : body;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function secretInput(element: HTMLElement, envName: string): HTMLInputElement {
  return element.querySelector<HTMLInputElement>(`[data-value='${envName}']`)!;
}

export function enterSecret(element: HTMLElement, envName: string, value: string): void {
  const input = secretInput(element, envName);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

export function clickAction(element: HTMLElement, action: string, envName: string): void {
  element
    .querySelector<HTMLButtonElement>(`[data-action='${action}'][data-env='${envName}']`)!
    .click();
}

export function snapshot(configured = false, revision = 1, accountId = "account-a"): Response {
  return response({ accountId, definitions: [{ envName: "API_TOKEN", configured, revision }] });
}

export function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
} {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const credentialRequestTarget = {
  requestId: "request-a",
  envName: "API_TOKEN",
  expectedAccountId: "account-a",
};

export async function mount(
  fetchImpl: typeof fetch,
  contextual = false,
): Promise<CredentialElement> {
  const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
  element.fetchImpl = fetchImpl;
  if (contextual) {
    element.target = credentialRequestTarget;
  }
  document.body.append(element);
  await vi.waitFor(() => expect(element.querySelector("[data-value]")).not.toBeNull());
  return element;
}

export function save(element: CredentialElement, value = "synthetic-only"): void {
  const input = element.querySelector<HTMLInputElement>("[data-value='API_TOKEN']")!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  element.querySelector<HTMLButtonElement>("[data-action='save']")!.click();
}
