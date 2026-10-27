// Exercise the installed ESM and CJS public APIs, without Vitest's module transform.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const probeSource = `import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mode = process.argv[1];
const { ConfidentialClientApplication, PublicClientApplication } = mode === "esm"
  ? await import("@azure/msal-node") : require("@azure/msal-node");
const origin = "https://login.microsoftonline.com";
const endpoint = origin + "/tenant/oauth2/v2.0/token";
const sent = [];
let tokenNonce = "request-nonce";
let discoveries = 0;
// The official network-client seam supplies deterministic Azure responses. All
// authority discovery, token serialization, state/nonce validation and caching
// still execute in the installed library; no application prototype is replaced.
const networkClient = {
  async sendGetRequestAsync(url) {
    discoveries++;
    throw new Error("Unexpected authority discovery: " + url);
  },
  async sendPostRequestAsync(url, options) {
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, endpoint);
    const body = new URLSearchParams(options.body);
    sent.push(body);
    const response = {
      token_type: "Bearer", scope: "scope", expires_in: 3600,
      access_token: "fixture-access-token",
    };
    if (body.get("grant_type") === "authorization_code") {
      const now = Math.floor(Date.now() / 1000);
      const claims = { aud: "fixture-client", iss: origin + "/tenant/v2.0",
        sub: "fixture-sub", oid: "fixture-user", tid: "tenant",
        iat: now, exp: now + 3600, nonce: tokenNonce };
      response.id_token = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
        + "." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".fixture";
    }
    return { headers: {}, status: 200, body: response };
  },
};
const auth = {
  clientId: "fixture-client", clientSecret: "fixture-secret",
  authority: origin + "/tenant", knownAuthorities: ["login.microsoftonline.com"],
  authorityMetadata: JSON.stringify({
    authorization_endpoint: origin + "/tenant/oauth2/v2.0/authorize",
    token_endpoint: endpoint, issuer: origin + "/tenant/v2.0",
    jwks_uri: origin + "/keys", end_session_endpoint: origin + "/logout",
  }),
};
function createClient(extraAuth = {}) {
  return new ConfidentialClientApplication({
    auth: { ...auth, ...extraAuth }, system: { networkClient, disableInternalRetries: true },
  });
}
assert.throws(() => createClient({ instanceAware: true }), { errorCode: "unsupported_cca_instance_aware" });
const cca = createClient({ instanceAware: false });
const urlRequest = { scopes: ["scope"], redirectUri: "https://app.example/callback" };
for (const value of ["true", "false", ""]) {
  await assert.rejects(cca.getAuthCodeUrl({ ...urlRequest,
    extraQueryParameters: { instance_aware: value } }), { errorCode: "unsupported_cca_instance_aware" });
}
assert.equal(sent.length, 0);
assert.equal(discoveries, 0);
const normalUrl = new URL(await cca.getAuthCodeUrl({ ...urlRequest, state: "fixture-state" }));
assert.equal(normalUrl.origin, origin);
assert.equal(normalUrl.searchParams.get("state"), "fixture-state");
const inheritedQuery = Object.create({ instance_aware: "true" });
assert.equal(new URL(await cca.getAuthCodeUrl({ ...urlRequest,
  extraQueryParameters: inheritedQuery })).searchParams.has("instance_aware"), false);

const request = { ...urlRequest, code: "request-code", nonce: "request-nonce", state: "fixture-state" };
const payload = { code: "attacker-code", nonce: "attacker-nonce", state: "fixture-state",
  cloud_instance_host_name: "attacker.example", cloud_graph_host_name: "attacker.example",
  msgraph_host: "attacker.example" };
const result = await cca.acquireTokenByCode(request, payload);
assert.equal(result.accessToken, "fixture-access-token");
assert.equal(result.idTokenClaims.nonce, "request-nonce");
assert.equal(result.cloudGraphHostName, "");
assert.equal(result.msGraphHost, "");
assert.equal(sent.length, 1);
assert.equal(sent[0].get("code"), "request-code");
assert.equal(sent[0].get("client_secret"), "fixture-secret");
assert.equal(discoveries, 0);
// Sanitizing routing metadata must preserve CSRF and ID-token nonce checks.
await assert.rejects(cca.acquireTokenByCode(request, { ...payload, state: "wrong" }), { errorCode: "state_mismatch" });
assert.equal(sent.length, 1);
tokenNonce = "attacker-nonce";
await assert.rejects(cca.acquireTokenByCode(request, payload), { errorCode: "nonce_mismatch" });
assert.equal(sent.length, 2);
tokenNonce = "request-nonce";
assert.equal((await cca.acquireTokenByCode(request)).accessToken, "fixture-access-token");
assert.equal(sent.length, 3);
// Azure Identity and Teams use this unchanged confidential-client grant.
const credentialResult = await cca.acquireTokenByClientCredential({ scopes: ["scope"], skipCache: true });
assert.equal(credentialResult.accessToken, "fixture-access-token");
assert.equal(sent.length, 4);
assert.equal(sent[3].get("grant_type"), "client_credentials");
assert.equal(sent[3].get("client_secret"), "fixture-secret");
assert.equal(sent[3].has("code"), false);
// Azure Identity's certificate grant must still sign an assertion for the
// configured authority, rather than sending a client secret or response route.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const certificateClient = createClient({ clientSecret: undefined, clientCertificate: {
  thumbprintSha256: "ab".repeat(32),
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
} });
assert.equal((await certificateClient.acquireTokenByClientCredential({
  scopes: ["scope"], skipCache: true,
})).accessToken, "fixture-access-token");
assert.equal(sent.length, 5);
assert.equal(sent[4].get("grant_type"), "client_credentials");
assert.equal(sent[4].has("client_secret"), false);
assert.equal(sent[4].get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
const [headerPart, claimsPart, signaturePart] = sent[4].get("client_assertion").split(".");
const assertionHeader = JSON.parse(Buffer.from(headerPart, "base64url"));
const assertionClaims = JSON.parse(Buffer.from(claimsPart, "base64url"));
assert.equal(assertionHeader.alg, "PS256");
assert.equal(assertionClaims.aud, endpoint);
assert.equal(assertionClaims.iss, "fixture-client");
assert.equal(assertionClaims.sub, "fixture-client");
assert.equal(verify("sha256", Buffer.from(headerPart + "." + claimsPart), {
  key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
}, Buffer.from(signaturePart, "base64url")), true);
// The confidential-client restriction must not remove public-client support.
const pca = new PublicClientApplication({ auth: { ...auth, clientSecret: undefined }, system: { networkClient } });
assert.equal(new URL(await pca.getAuthCodeUrl({ ...urlRequest,
  extraQueryParameters: { instance_aware: "true" } })).searchParams.get("instance_aware"), "true");
console.log(JSON.stringify({ mode, tokenRequests: sent.length, unexpectedDiscoveries: discoveries }));
`;

it.each(["esm", "cjs"])("preserves trusted MSAL %s confidential-client flows", (mode) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeSource, mode], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ mode, tokenRequests: 5, unexpectedDiscoveries: 0 });
});
