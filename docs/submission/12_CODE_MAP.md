---
summary: "PlatformClaw 기능별 source, test, runtime evidence와 internal requirement"
read_when:
  - "제출 claim의 실제 코드와 테스트 경로를 확인할 때"
title: "Code Map"
---

# Code Map

이 표는 주요 기능의 source, test, runtime evidence, 제한과 internal requirement를 연결한다. claim 상태의 최종 기준은 `submission/evaluation-map.yaml`이다.

| 기능                                | 상태                            | Source                                                                             | Test                                           | Runtime                   | 제한 / IR                        |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------- | -------------------------------- |
| Multi-user Control Plane            | `IMPLEMENTED`                   | `packages/platformclaw-control-plane/src/contracts.ts`, `sqlite-store*.ts`         | `memory-store.test.ts`, `sqlite-store.test.ts` | Docker smoke              | actual users `IR-009`            |
| Employee Auth                       | `IMPLEMENTED_WITH_LIMITATIONS`  | `employee-auth-client.ts`, `browser-auth-service.ts`                               | 동명 tests                                     | Mock auth in Docker smoke | internal endpoint `IR-008`       |
| Browser Session                     | `IMPLEMENTED`                   | `browser-auth-service.ts`, `contracts.ts`                                          | `browser-auth-*.test.ts`                       | Docker login smoke        | actual SSO `IR-008`              |
| User Authorization                  | `IMPLEMENTED`                   | `browser-gateway-policy.ts`, `ownership.ts`, `event-policy.ts`                     | `browser-gateway-proxy*.test.ts`               | Docker browser flow       | —                                |
| Personal Agent provisioning         | `IMPLEMENTED`                   | `personal-agent-provisioner.ts`                                                    | 동명 test                                      | Docker smoke              | —                                |
| Group Agent ownership               | `IMPLEMENTED_WITH_LIMITATIONS`  | `knox-room-agent-provisioner.ts`, `knox-routing-service.ts`                        | routing test                                   | Mock flow                 | actual Knox `IR-007`             |
| Workspace/Session isolation         | `IMPLEMENTED`                   | browser Gateway policy modules                                                     | proxy/session tests                            | Mock cross-user denial    | —                                |
| VM Assignment/Admin                 | `IMPLEMENTED`                   | `execution-contracts.ts`, `sqlite-store-execution*.ts`, `browser-vm-admin-http.ts` | execution/admin tests                          | Docker smoke              | actual VM `IR-009`               |
| SafeConnect/SSH                     | `IMPLEMENTED`                   | `safeconnect-probe.ts`, execution plugin                                           | probe/backend tests                            | Docker smoke              | internal network `IR-009`        |
| Encrypted credential                | `IMPLEMENTED`                   | `ssh-credential-crypto.ts`, `vault.ts`                                             | vault tests                                    | Docker smoke              | secret supplied internally       |
| One-shot broker                     | `IMPLEMENTED`                   | `credential-broker-grants.ts`, `ssh-credential-broker.ts`                          | broker/grant tests                             | Docker smoke              | —                                |
| SSH master lease                    | `IMPLEMENTED`                   | `extensions/platformclaw-execution/src/ssh-lease-manager.ts`                       | lease-manager test                             | integration path          | actual VM `IR-009`               |
| Rootless Docker                     | `IMPLEMENTED`                   | `docker/platformclaw-runtime/`                                                     | config scripts                                 | runtime Docker smoke      | Linux authority                  |
| Sandbox routing                     | `IMPLEMENTED`                   | managed config + execution plugin                                                  | runtime tests                                  | Docker smoke              | —                                |
| Personal MCP credential             | `IMPLEMENTED`                   | `mcp-credential-*.ts`, user-mcp plugin                                             | MCP tests                                      | Docker runtime            | internal servers configured      |
| Admin global MCP                    | `IMPLEMENTED_WITH_LIMITATIONS`  | `browser-mcp-admin-http.ts`, admin RPC                                             | admin MCP tests                                | UI E2E                    | actual registry `IR-008`         |
| Remote Skill discovery/refresh      | `IMPLEMENTED_WITH_LIMITATIONS`  | `remote-skills.ts`                                                                 | `remote-skills.test.ts`                        | assigned VM path          | actual VM `IR-009`               |
| Per-run snapshot                    | `IMPLEMENTED`                   | execution plugin runtime/backend                                                   | runtime tests                                  | target snapshot           | actual skill provenance `IR-003` |
| Employee context                    | `IMPLEMENTED`                   | `employee-profile-artifact.ts`                                                     | artifact/provisioner tests                     | login flow                | no credential                    |
| Web ingress                         | `IMPLEMENTED`                   | `web-ingress-server.ts`, `runtime.ts`                                              | ingress tests                                  | Docker smoke              | reverse proxy deployment-owned   |
| Knox ingress/DM/group               | `IMPLEMENTED_WITH_LIMITATIONS`  | `extensions/knox/src/`, Control routing                                            | Knox/routing tests                             | Mock                      | `IR-007`, `IR-009`               |
| Restricted Control UI               | `IMPLEMENTED`                   | `ui/src/platformclaw/`                                                             | unit/E2E                                       | UI build/demo             | actual screenshots `IR-009`      |
| Retry/recovery/cleanup/audit        | `IMPLEMENTED_WITH_LIMITATIONS`  | reconciler, stores, lease managers                                                 | focused tests                                  | Docker + Mock             | actual failure `IR-009`          |
| Linux Docker deployment             | `IMPLEMENTED_WITH_LIMITATIONS`  | `docker/platformclaw-runtime/`, build script                                       | config guards                                  | Docker smoke              | internal deploy `IR-009`         |
| Board Farm contract                 | `MOCK_VERIFIED`                 | `packages/platformclaw-control-plane/src/board-farm/`                              | board-farm tests                               | Mock evidence             | `IR-001`, `IR-002`               |
| Global Build/Validation/Jira/Notify | `INTERNAL_INTEGRATION_REQUIRED` | templates only                                                                     | acceptance templates                           | none actual               | `IR-003`~`IR-007`                |

## Path rules

- PlatformClaw-specific production logic은 private package/plugin 경계에 둔다.
- plugin production code는 core `src/**`를 deep import하지 않는다.
- source/test가 없는 `IMPLEMENTED` claim은 허용하지 않는다.
- Runtime proof가 필요한 완성도 claim은 Mock 또는 actual evidence path를 가져야 한다.
