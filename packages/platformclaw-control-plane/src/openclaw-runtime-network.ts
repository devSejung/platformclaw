// Narrow runtime bridge: reuse OpenClaw's DNS-pinned redirect-aware SSRF guard.

export { fetchWithSsrFGuard } from "../../../src/infra/net/fetch-guard.js";
