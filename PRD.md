# PlatformClaw 제품 요구사항

## 1. 제품 정의

PlatformClaw는 여러 엔지니어가 각자의 Assistant와 Workspace를 통해 사용자 소유의 개인 개발 VM에 안전하게 접속하도록 하고, 인증된 요청을 개인 또는 그룹 Agent로 연결한 뒤 코드 수정·빌드·Board Farm MCP 보드 제어·검증·증거·Jira·Knox 결과까지 추적하는 멀티유저 AI 엔지니어링 플랫폼이다.

이 PRD는 제출 branch에서 검증 가능한 외부 기능과 사내 연동이 필요한 기능을 분리한다. 상태 기준은 `submission/evaluation-map.yaml`, 내부 작업 기준은 `submission/internal-requirements.yaml`이다.

## 2. 대상 사용자와 기존 업무

| 사용자                 | 기존 업무                                         | PlatformClaw 목표                                           |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Firmware/SoC engineer  | 채팅·IDE·개인 개발 VM·Board Farm·Jira를 수동 전환 | 자신의 VM에 Agent가 접속하고 한 Run으로 실행·검증·보고 연결 |
| Group room participant | 방 문맥과 개인 환경이 섞일 위험                   | room별 Agent와 Sandbox를 사용하고 개인 VM·credential 차단   |
| Platform administrator | 사용자·VM·MCP·운영 상태를 여러 도구에서 관리      | 제한된 admin surface와 audit owner 명시                     |
| System service         | 인증·실행·결과를 불명확한 신뢰로 연결             | service identity, bounded endpoint, one-shot secret로 연결  |

## 3. 문제

1. 사용자별 Agent, session, Workspace, credential 경계가 없으면 교차 사용자 접근이 발생할 수 있다.
2. 실행 위치가 암묵적이면 동일한 요청이 shared server, 개인 VM, container 중 어디에서 수행됐는지 설명하기 어렵다.
3. 개인 개발 VM의 source·build 결과와 Board Farm MCP의 lease·control·evidence 책임이 분산된다.
4. 최종 결과가 Jira와 Knox에 전달되어도 원 실행·artifact·보드와 연계되지 않으면 감사 가능성이 낮다.
5. 사내 시스템은 외부에서 접근할 수 있으므로, 계약·Mock과 실제 evidence를 엄격히 구분해야 한다.

## 4. User Story

- 엔지니어로서 로그인하면 내 Personal Agent와 Workspace를 반복 생성 없이 사용하고 싶다.
- 엔지니어로서 PlatformClaw가 다른 사용자의 환경과 섞이지 않은 채 내 기존 개인 개발 VM에 접속해 코드를 수정하고 빌드하기를 원한다.
- 엔지니어로서 현재 작업 위치가 Basic Sandbox인지 assigned VM인지 화면과 실행 결과에서 확인하고 싶다.
- 그룹 참여자로서 개인 VM과 개인 credential이 room Agent에 노출되지 않기를 원한다.
- 검증 담당자로서 Board Farm MCP lease와 control이 요청 소유권을 따르고, timeout·validation 실패에도 evidence가 남기를 원한다.
- 관리자로서 VM·MCP·사용자 정책을 employee surface와 분리된 경계에서 관리하고 싶다.
- 운영자로서 Run ID와 correlation ID를 따라 failure, retry, cleanup과 보고 결과를 확인하고 싶다.

## 5. 핵심 Scenario

### Personal Scenario

Web login 또는 Knox DM이 directory identity를 개인 Agent의 `main` session에 연결한다. 사용자는 `platform_server` 또는 자신에게 할당된 `assigned_vm` 중 준비된 대상을 선택한다. PlatformClaw는 SafeConnect/SSH 경계로 해당 개인 개발 VM의 Workspace에 접속해 코드 수정과 빌드를 수행한다. Target revision은 Run에 고정되며 자격 증명은 브라우저·transcript·Workspace에 기록되지 않는다.

현재 상태: 인증·provisioning·session·VM/Sandbox·credential 경계는 `IMPLEMENTED` 또는 `IMPLEMENTED_WITH_LIMITATIONS`; 실제 사내 endpoint를 통한 end-to-end는 `INTERNAL_INTEGRATION_REQUIRED`.

### Group Scenario

Knox room은 `group-{chatroomId}` Agent와 해당 Agent의 `main` session을 idempotent하게 사용한다. Group은 개인 Agent와 분리되고 개인 VM·개인 credential을 사용하지 않으며 정책 Sandbox로 실행한다.

현재 상태: routing과 room provisioning은 `IMPLEMENTED_WITH_LIMITATIONS`; 실제 CDEP와 group membership 운영 증거는 `INTERNAL_INTEGRATION_REQUIRED`.

### Admin Scenario

관리자는 employee BFF와 분리된 surface에서 사용자 상태, VM catalog/allocation, global MCP 정책을 관리한다. 브라우저에 secret 원문을 반환하지 않는다.

현재 상태: 주요 HTTP/RPC와 UI projection은 `IMPLEMENTED_WITH_LIMITATIONS`; 사내 RBAC·endpoint 배포 검증은 `INTERNAL_INTEGRATION_REQUIRED`.

## 6. 기능 요구사항

| ID    | 요구사항                                                                           | 상태                            | Acceptance Evidence                                                  |
| ----- | ---------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| FR-01 | Employee principal을 canonical user로 upsert한다                                   | `IMPLEMENTED`                   | `browser-auth-service.test.ts`, `sqlite-store.test.ts`               |
| FR-02 | Personal Agent provisioning은 idempotent하고 ownership conflict에 fail closed한다  | `IMPLEMENTED`                   | `personal-agent-provisioner.test.ts`                                 |
| FR-03 | Browser method/result/event는 인증된 personal Agent와 session으로 제한한다         | `IMPLEMENTED`                   | `browser-gateway-proxy*.test.ts`                                     |
| FR-04 | VM assignment는 user/Agent ownership과 target revision을 검사한다                  | `IMPLEMENTED`                   | `execution-store.test.ts`, `execution-handoff-service.test.ts`       |
| FR-05 | Basic execution은 rootless Docker를 사용한다                                       | `IMPLEMENTED`                   | `scripts/e2e/platformclaw-runtime-docker.sh`                         |
| FR-06 | SSH credential은 encrypted envelope와 one-shot broker로만 전달한다                 | `IMPLEMENTED`                   | `ssh-credential-vault.test.ts`, `ssh-credential-broker.test.ts`      |
| FR-07 | Personal MCP credential은 user/server binding으로 암호화·격리한다                  | `IMPLEMENTED`                   | `mcp-credential-vault.test.ts`, `platformclaw-user-mcp` tests        |
| FR-08 | Knox DM은 Web 활성 personal Agent에, room은 room Agent에 연결한다                  | `IMPLEMENTED_WITH_LIMITATIONS`  | `knox-routing-service.test.ts`, `extensions/knox/src/*.test.ts`      |
| FR-09 | Board Farm lease ownership과 lifecycle을 deterministic Mock으로 검증한다           | `MOCK_VERIFIED`                 | `packages/platformclaw-control-plane/src/board-farm/`, Mock evidence |
| FR-10 | 실제 Board Farm MCP lease·control과 Jira·Knox flow를 내부 adapter/Skill로 연결한다 | `INTERNAL_INTEGRATION_REQUIRED` | `IR-001`~`IR-007`                                                    |
| FR-11 | actual evidence와 5분 MP4를 생성한다                                               | `INTERNAL_INTEGRATION_REQUIRED` | `IR-009`~`IR-011`                                                    |

## 7. 비기능 요구사항

### Security

- default-deny authorization; UI 숨김은 권한 근거로 사용하지 않는다.
- secret은 Docker secret file 또는 encrypted SQLite envelope로 관리한다.
- actual evidence는 personal identifier, secret, internal hostname을 마스킹한다.
- group Agent는 personal VM, personal credential, personal Workspace를 사용할 수 없다.

### Reliability

- provisioning과 lease는 idempotent해야 한다.
- retry는 동일 correlation ID를 보존하고 중복 deploy/report/notification을 만들지 않아야 한다.
- restart reconciliation은 incomplete state를 owner boundary에서 복구하거나 명시적으로 실패시킨다.
- 실패해도 이미 수집된 evidence를 제거하지 않는다.

### UX

- 사용자는 identity, Agent, Workspace, Execution Target, Run state를 확인할 수 있어야 한다.
- loading, empty, error, retry state가 보이고 실패 메시지는 다음 행동을 제시해야 한다.
- employee와 administrator navigation을 구분한다.

### Portability and operations

- Windows는 개발 host지만 최종 runtime authority는 Ubuntu Linux Docker다.
- 외부 제출 gate는 credential 없이 결정적으로 실행되어야 한다.
- 실제 사내 integration은 source에 secret 또는 private URL을 기록하지 않아야 한다.

## 8. 제외 범위

- 범용 consumer messaging product 제공: `OUT_OF_SCOPE`
- upstream consumer channel·native app을 해커톤 제품 surface로 노출: `OUT_OF_SCOPE`
- 외부 환경에서 실제 사내 Board Farm/Jira/Knox 호출: `OUT_OF_SCOPE`
- 사내 측정 전 임의의 시간 절감·성공률 수치 제시: `OUT_OF_SCOPE`
- generic core namespace와 protocol을 PlatformClaw 이름으로 전면 변경: `OUT_OF_SCOPE`

## 9. 성공 조건과 측정

### 외부 준비 성공

- `pnpm submission:verify:external` 성공
- Mock Golden Path가 `mode: mock` evidence를 결정적으로 생성
- User B의 User A resource 접근이 거부
- 문서 claim의 code/test/docs path가 존재
- offline slide, attribution, blindness, secret/PII 검사가 성공

### 사내 최종 성공

- `IR-001`~`IR-013`이 모두 완료
- 실제 개인 개발 VM의 code change·build와 Board Farm MCP lease·deploy·boot·control·validate가 같은 Run으로 연결
- Jira와 Knox 결과가 evidence manifest와 연계
- 최소 1개 failure scenario와 retry/recovery가 실제로 검증
- `pnpm submission:verify:final` 성공

### 측정 항목

End-to-end Time, Human Interaction Count, Tool Switching Count, Retry Count, Success Rate, Failure Diagnosis Time, Onboarding Time, Hardware Utilization, Evidence Completeness를 actual Golden Run에서 측정한다. 측정 전 숫자는 기록하지 않는다.

## 10. 사내 의존성과 최종 Acceptance Criteria

사내 의존성은 `submission/internal-requirements.yaml`의 `IR-001`~`IR-013`만 허용한다. 최종 acceptance는 실제 adapter/Skill source, sanitized actual evidence, measured metrics, 5분 이내 MP4, final gate, private remote CI, final branch와 tag가 함께 존재할 때 충족된다.
