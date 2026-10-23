# OpenClaw live proof routing

Determine the actual current command and owner from root and scoped
`AGENTS.md`, the current source tree, package scripts, and existing scenario
inventory. Do not preserve stale invocation details as product contracts.

## Providers and scenarios

Read `.agents/skills/openclaw-qa-testing/SKILL.md`,
`qa/scenarios/index.yaml`, and the currently owning QA suite. Derive the
`live-frontier` provider and current authorized `openai/<model>` from the
user's request, the current QA skill, and the actual available model catalog.
Do not hard-code a historical model, silently substitute an unavailable model,
or claim provider proof when selection fails. Require actual nonempty model
selection and passing prompt, tool, file, or image checks for the capability
being claimed.

Use an isolated authorized OpenAI credential. Never emit its value, persist it
in reports, or assume that a passing mock proves a real provider. Inspect the
real configured `agents.list`; resolve an agent that actually exists before
claiming gateway or model success. Prove the delivered model-final response and
the independently persisted session or transcript as separate product paths.
Preserve redacted artifact paths, provider/model identity, exact command, run
ID, and the actual executed/passed/skipped counts.

A standard `pnpm build` intentionally excludes private QA plugins. Run QA from
the source checkout or explicitly build with `OPENCLAW_BUILD_PRIVATE_QA=1`.
Place QA output under the repo-relative `.artifacts/` directory.

## Gateway, package, and apps

Start only campaign-owned gateways with distinct unused ports and an isolated
state directory. Probe the actual public route or protocol, not a fixture that
bypasses the transport. Never bind the operator's port or change a running
launchd/systemd service.

Inspect the rendered page before accepting visual evidence. A screenshot,
successful navigation, or HTTP response is not a passing Control UI proof when
the page displays `GatewayRequestError`, `UNKNOWN_AGENT`, or another gateway
failure. Preserve only screenshots that show the requested working surface.

Keep existing long-running campaign gateways on their independently recorded
immutable source and live process. Starting a newer main-review wave does not
authorize restarting, rebuilding, or replacing an in-progress soak.

For packaging or Git-plugin claims, exercise a newly built real package and
the complete install/update scenario. Preserve real command exits and avoid
stale images or package artifacts.

Read the app's scoped owner guide. Record whether macOS app signing, physical
iOS/Android devices, simulators, Android emulators, or hosted runners were
actually available and exercised. Source inspection is not runtime proof.

## Execution environment

Root `AGENTS.md` Validation owns environment selection; `$openclaw-testing`
and the scenario owner still define the required checks and proof. For trusted
heavy suites, packaging, browser, and live-provider proof, use Docker Desktop
Linux first, then a healthy WSL distribution when Docker is unsuitable. Use
supported existing GitHub Actions workflows for mandatory hosted/native proof.
Docker/WSL success does not replace required native, packaged-upgrade, or
live-channel evidence. Crabbox and Testbox are unavailable; do not probe, warm,
invoke, or retry either service unless the user explicitly confirms restoration.
Do not use DevSpace or automatically launch another external agent runner.

Acquire only task-owned environments, verify the exact candidate SHA or dirty
patch identity, and serialize commands that share mutable state or a repository
lock. Provision dependencies in a separate Linux checkout/dependency volume,
never through a bind mount onto the Windows checkout or its `node_modules`.
Never run `pnpm install` or reconciliation in Windows linked/sparse worktrees.
A 780-second timeout bounds an individual subagent scenario after setup.

If a controlling session disappears, inspect the original container, WSL
process, or CI job, recorded command, and authoritative exit before retrying.
A missing session neither proves success nor permits a competing shared-state
run. Record environment, exact command, source identity, exit, sanitized
artifacts, and any unavailable prerequisites; unknown results remain gaps.

Untrusted contributor/fork code, including scripts, wrappers, config, tests,
and install hooks, runs only on existing secretless fork CI at the reviewed
immutable full SHA. Never execute it on the host, Docker Desktop, WSL, or a
credentialed runner. Follow root trust isolation; if suitable CI is unavailable,
report the proof gap instead of using a local fallback.
