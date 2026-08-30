---
summary: "Run PlatformClaw Control UI with Vite HMR against a running control plane"
read_when:
  - Developing PlatformClaw Control UI changes
  - Testing PlatformClaw login, session, or settings screens locally
title: "PlatformClaw UI development"
---

# PlatformClaw UI development

Use the optional Vite workflow when changing files under `ui/`. The backend
continues to run on its normal control-plane port; Vite serves source modules
and applies UI changes through HMR without rebuilding or restarting that
backend.

## Start

Start the existing PlatformClaw control plane and Gateway first. When running
the control plane directly from the checkout, its entry point is:

```powershell
corepack pnpm platformclaw:control
```

Use the deployment environment variables documented in
[Web ingress runtime](/platformclaw/web-ingress-runtime).
Then run the UI dev server from a second terminal:

```powershell
corepack pnpm platformclaw:ui:dev
```

If a control-plane process was started from an older checkout or is still
serving a previous UI snapshot, stop it and start the current checkout once
before opening Vite. After that initial backend start, UI edits do not require
another backend restart or frontend rebuild.

Open `http://127.0.0.1:5173/platformclaw/login`. The dev server proxies
PlatformClaw API, employee-auth, health, and Gateway WebSocket requests to the
control plane at `http://127.0.0.1:19001` by default.

If the backend uses another origin, set the target in an untracked `.env` file
or the process environment:

```powershell
$env:PLATFORMCLAW_DEV_BACKEND_URL = "http://backend-host:19001"
corepack pnpm platformclaw:ui:dev
```

For ADSSO callback testing, configure the backend and employee-auth mock's
public origin to the Vite origin (`http://127.0.0.1:5173`) when starting that
local stack, then set the forwarded request origin to match it:

```powershell
$env:PLATFORMCLAW_DEV_REQUEST_ORIGIN = "http://127.0.0.1:5173"
corepack pnpm platformclaw:ui:dev
```

Password login and session/API checks work through the proxy with the default
backend origin.

## Production workflow

The existing `corepack pnpm ui:build` and PlatformClaw static-file serving path
are unchanged. Use them for production-style previews and release validation;
`platformclaw:ui:dev` is an opt-in development workflow only.
