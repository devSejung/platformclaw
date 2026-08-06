---
summary: "PlatformClaw 제출의 proof hierarchy, test matrix와 CI gate"
read_when:
  - "외부 또는 사내 제출 검증 command를 선택할 때"
title: "Testing과 CI"
---

# Testing과 CI

## Proof hierarchy

1. focused unit/behavior test: owner invariant
2. cross-component integration test: request→state→result
3. UI E2E: role, loading/error/retry와 presentation
4. Linux Docker runtime smoke: final runtime boundary
5. Mock Golden Path: full external workflow, `mode: mock`
6. actual Golden Run: internal systems, sanitized evidence

Snapshot-only test는 security와 behavior claim의 근거로 사용하지 않는다.

## Required behavior coverage

| 영역             | 핵심 proof                                               | 대표 경로                                                          |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| auth/session     | success, reject, revoke, expiry, hash-only token         | `browser-auth-*.test.ts`                                           |
| tenant isolation | User B request/result/event/session 거부                 | `browser-gateway-proxy*.test.ts`                                   |
| provisioning     | idempotency, conflict, retry, restart                    | `personal-agent-provisioner.test.ts`, `restart-reconciler.test.ts` |
| VM/credential    | ownership, encryption, one-shot, revision                | `execution-*.test.ts`, `ssh-credential-*.test.ts`                  |
| Sandbox          | rootless daemon, Workspace mount, no host socket         | `platformclaw-runtime-docker.sh`                                   |
| Knox             | DM/room route, HMAC, sender preservation, delivery error | Control/Knox tests                                                 |
| MCP/Skill        | credential isolation, invalidate, snapshot refresh       | MCP and remote-skill tests                                         |
| Board Farm       | build gate, cross-user, timeout, renew, stale, evidence  | board-farm tests                                                   |
| workflow         | failure stop, report/notification evidence preservation  | Mock Golden Path                                                   |
| UI               | role, theme, loading/error/retry, target/MCP             | `ui/src/e2e/platformclaw-*.test.ts`                                |

## Local commands

```bash
node scripts/platformclaw-check.mjs --changed --quick
node scripts/platformclaw-check.mjs --changed
pnpm submission:test:mock
pnpm submission:slides:check
pnpm submission:self-review
pnpm submission:verify:external
```

Linux Docker:

```bash
docker compose -f docker/platformclaw-runtime/compose.yaml config
pnpm test:docker:platformclaw-runtime
```

사내 final:

```bash
pnpm submission:verify:final
```

## CI

- `.github/workflows/platformclaw-ci.yml`: changed-surface fast gate
- `.github/workflows/platformclaw-full-ci.yml`: main/sync broad assurance
- `.github/workflows/platformclaw-submission.yml`: prep/final branch, PR, dispatch submission gate

GitHub-hosted runner는 credential-free external gate만 실행한다. internal actual gate는 검증된 self-hosted runner 또는 사내 local command에서 실행하며, public runner가 성공한 것처럼 표시하지 않는다.

## Submission gate

External gate는 format/lint/typecheck/test/build, Docker Mock, Markdown link와 referenced path, evaluation map, attribution, offline slide, secret/PII/internal hostname, prompt injection, conflict marker, whitespace, Mock/Actual 구분을 검사한다.

Final gate는 external gate에 더해 actual Board Farm/Skill/build/boot/validation/Jira/Knox evidence, screenshot, metric, video metadata, `INTERNAL_INTEGRATION_REQUIRED` 0개와 internal requirement 완료를 요구한다.

## Windows linked worktree

linked worktree에서는 `pnpm install`을 실행하지 않는다. `node scripts/run-vitest.mjs`와 `node scripts/check-changed.mjs` 같은 repository wrapper 또는 primary checkout toolchain을 재사용한다. Linux Docker가 runtime validation authority다.
