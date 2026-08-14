#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const baseUrl = process.env.SKILLHUB_BASE_URL ?? "http://skillhub.platformclaw.local:8080";
const passwordFile = process.env.SKILLHUB_BOOTSTRAP_PASSWORD_FILE;
const username = "platformclaw-bootstrap";
if (!passwordFile) throw new Error("SKILLHUB_BOOTSTRAP_PASSWORD_FILE is required");

const cookies = new Map();
function absorbCookies(response) {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookies.size > 0) {
    headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  if (init.method && init.method !== "GET") {
    const csrf = cookies.get("XSRF-TOKEN");
    if (!csrf) throw new Error("SkillHub did not issue a CSRF cookie");
    headers.set("x-xsrf-token", decodeURIComponent(csrf));
  }
  const response = await fetch(new URL(path, baseUrl), { ...init, headers });
  absorbCookies(response);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`SkillHub bootstrap ${path} failed with HTTP ${response.status}`);
  }
  return body ? JSON.parse(body) : undefined;
}

await request("/api/v1/auth/methods");
await request("/api/v1/auth/direct/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    provider: "local",
    username,
    password: readFileSync(passwordFile, "utf8").trim(),
  }),
});

const configuredNamespaces = (process.env.SKILLHUB_NAMESPACES ?? "")
  .split(",")
  .map((policy) => policy.split("=", 1)[0].trim().toLowerCase())
  .filter(Boolean);
const existing = await request("/api/v1/namespaces?size=200");
const existingSlugs = new Set(existing?.data?.items?.map((item) => item.slug) ?? []);
for (const slug of configuredNamespaces) {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(slug)) {
    throw new Error(`Invalid configured SkillHub namespace: ${slug}`);
  }
  if (slug === "global" || existingSlugs.has(slug)) continue;
  await request("/api/v1/namespaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug,
      displayName: slug,
      description: "PlatformClaw managed namespace",
    }),
  });
}

if (process.env.SKILLHUB_CREATE_TOKEN === "true") {
  const created = await request("/api/v1/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "platformclaw-control",
      scopes: ["skill:read", "skill:publish"],
    }),
  });
  const token = created?.data?.token;
  if (typeof token !== "string" || !token.startsWith("sk_")) {
    throw new Error("SkillHub returned no API token");
  }
  const outputFile = process.env.SKILLHUB_TOKEN_OUTPUT_FILE;
  if (!outputFile) throw new Error("SKILLHUB_TOKEN_OUTPUT_FILE is required");
  writeFileSync(outputFile, `${token}\n`, { mode: 0o600 });
}
