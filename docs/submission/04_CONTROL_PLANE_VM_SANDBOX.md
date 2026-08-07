---
summary: "Control Plane owner, assigned VM, rootless Sandbox와 skill snapshot"
read_when:
  - "개인 실행 위치와 VM/Sandbox 정책을 검토할 때"
title: "Control Plane, VM과 Sandbox"
---

# Control Plane, VM과 Sandbox

## Control Plane ownership

`packages/platformclaw-control-plane`은 principal, user, Agent binding, browser session, managed scope, VM endpoint/host/allocation, execution profile, credential envelope, MCP binding과 audit의 canonical owner다. runtime은 SQLite의 current schema만 읽고, Gateway와 private plugins에는 필요한 snapshot만 전달한다.

상태: `IMPLEMENTED`.

PlatformClaw의 핵심 개인 경로는 단순히 VM을 새로 만드는 기능이 아니다. 여러 사용자의 Personal Agent가 각 사용자에게 이미 할당된 사내 개발 VM과 Workspace에 접속해 코드 수정·빌드를 수행할 수 있게 하되, 다른 사용자의 VM·Workspace·credential로 넘어가지 못하게 하는 시스템이다.

## Personal Agent와 Workspace

login 시 `BrowserAuthService`가 principal upsert와 Personal Agent reservation을 수행하고 `GatewayPersonalAgentProvisioner`가 정확한 Agent, Workspace와 profile owner를 검증한다. concurrent login은 동일 binding을 사용한다. incomplete provisioning은 `RestartReconciler`가 public ingress 전 처리한다.

근거:

- `packages/platformclaw-control-plane/src/browser-auth-service.ts`
- `packages/platformclaw-control-plane/src/personal-agent-provisioner.ts`
- `packages/platformclaw-control-plane/src/restart-reconciler.ts`
- 동명 테스트

## Execution Target

`platform_server`와 `assigned_vm`은 서로 다른 workspace·runtime이다. 사용자는 administrator-approved catalog에서 자신에게 할당된 개인 개발 VM만 선택한다. candidate connection이 remote home/workspace와 host key를 검증한 뒤 allocation을 revision-checked commit한다. target change는 Run boundary에서 atomic snapshot으로 적용되고 자동 fallback은 없다.

상태: `IMPLEMENTED`; 실제 사내 VM proof는 `IR-009`.

## SafeConnect와 SSH

`extensions/platformclaw-execution`은 upstream sandbox backend seam을 구현한다. pinned host key, endpoint/VM metadata와 user-owned allocation을 사용한다. `SafeConnectSshLeaseManager`는 credential/target revision별 bounded master lease를 재사용하고, concurrency cap·idle expiry·master exit·credential rotation을 처리한다.

근거: `extensions/platformclaw-execution/src/backend.ts`, `ssh-lease-manager.ts`와 테스트.

## Rootless Docker

Basic과 group execution은 dedicated rootless Docker daemon을 사용한다. managed config는 `sandbox.mode: all`, Agent scope, read-write owned Workspace와 approved backend를 강제하고 host control 및 host Docker socket을 허용하지 않는다.

근거:

- `docker/platformclaw-runtime/compose.yaml`
- `docker/platformclaw-runtime/validate-managed-config.mjs`
- `docker/platformclaw-runtime/reconcile-managed-config.mjs`
- `scripts/e2e/platformclaw-runtime-docker.sh`

상태: `IMPLEMENTED`.

## Remote Skill Snapshot

assigned VM skill discovery는 bounded scanner 결과를 target revision별 cache하고 explicit refresh에서만 다시 읽는다. 각 Run은 준비된 target과 skill snapshot을 사용하며, 위치 변경이 현재 Run의 prompt/tool contract를 중간에 바꾸지 않는다.

근거: `extensions/platformclaw-execution/src/remote-skills.ts`, `remote-skills.test.ts`.

상태: `IMPLEMENTED_WITH_LIMITATIONS`. 실제 사내 VM의 skill provenance는 `IR-003`, `IR-009`에서 검증한다.

## 제한

- 실제 SafeConnect/VM 주소와 credential은 source에 없으며 actual proof는 사내에서 수행한다.
- group room의 실제 membership과 Docker run proof는 `IR-009`.
- Board Farm lease/control은 VM/Sandbox backend의 일부가 아니라 별도 사내 MCP integration이다.
