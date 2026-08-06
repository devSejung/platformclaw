# 출처와 해커톤 범위

PlatformClaw는 OpenClaw 기반임을 숨기지 않는다. 이 문서는 기존 아이디어, fresh upstream fork, 해커톤 신규 구현, 사내 자산과 신규 통합 가치를 분리한다.

## 1. Legacy PlatformClaw POC

해커톤 이전 POC는 아이디어 가능성을 확인한 구형 구현이다. 현재 제출 코드의 ancestry나 production base가 아니며, 현재의 VM 연결, Sandbox 정책, Multi-user Control Plane, Board Farm workflow를 구현한 것으로 간주하지 않는다. POC의 구체 source와 사내 정보는 제출 저장소에 포함하지 않는다.

상태: `OUT_OF_SCOPE`.

## 2. Fresh OpenClaw Fork

현재 제출 구현은 OpenClaw Git ancestry를 보존한 fresh downstream에서 시작했다.

- 제출 branch baseline: `dae6d288c6f0d6e543955c13f73a03967b794e6c`
- 확인된 upstream common ancestor: `02457657f012d33e141c710d92671d1bc4a519e9`
- upstream: `https://github.com/openclaw/openclaw`
- 보존 영역: generic Gateway, Agent, Session, Tool, Plugin SDK, Sandbox, Control UI 기반
- 호환성 때문에 유지하는 이름: `@openclaw/*`, Gateway Protocol, Plugin SDK, migration·CLI·session contract

OpenClaw 저작권과 라이선스는 [LICENSE](LICENSE)에, dependency 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 보존한다.

## 3. 해커톤 기간의 PlatformClaw 구현·대규모 재설계

다음은 downstream 제품 경계에서 개발·재설계된 영역이다.

- enterprise principal, browser session, multi-user authorization
- idempotent Personal/Knox room Agent provisioning
- user/Agent/session/workspace ownership enforcement
- VM assignment, SafeConnect/SSH execution, target revision
- encrypted SSH/MCP credential envelope와 one-shot broker
- rootless Docker sandbox deployment policy
- Knox DM/room routing과 restricted employee Web surface
- PlatformClaw login, theme, execution/MCP/admin UI
- restart reconciliation, audit, deployment smoke
- Board Farm domain contract, deterministic Mock workflow와 submission gates

세부 파일은 `docs/submission/12_CODE_MAP.md`와 `submission/evaluation-map.yaml`에서 확인한다.

## 4. 기존 사내 자산

다음은 이 저장소에서 새로 구현 완료했다고 주장하지 않는 사내 자산이다.

| 자산                                | 상태                            | Requirement        |
| ----------------------------------- | ------------------------------- | ------------------ |
| 실제 Board Farm MCP와 내부 endpoint | `INTERNAL_INTEGRATION_REQUIRED` | `IR-001`, `IR-002` |
| PlatformClaw Global Skill baseline  | `INTERNAL_INTEGRATION_REQUIRED` | `IR-003`           |
| Firmware Build Skill                | `INTERNAL_INTEGRATION_REQUIRED` | `IR-004`           |
| Board Validation Skill              | `INTERNAL_INTEGRATION_REQUIRED` | `IR-005`           |
| Jira Report Skill                   | `INTERNAL_INTEGRATION_REQUIRED` | `IR-006`           |
| 실제 Knox result delivery           | `INTERNAL_INTEGRATION_REQUIRED` | `IR-007`           |
| 사내 저장소·정책·보드·VM            | `INTERNAL_INTEGRATION_REQUIRED` | `IR-008`~`IR-010`  |

템플릿은 integration point와 acceptance test를 설명할 뿐, 실제 사내 asset의 source나 credential을 포함하지 않는다.

## 5. 해커톤 신규 통합 가치

신규 가치는 단일 기능의 재현이 아니라 사용자 요청 → identity/ownership → isolated execution → build → exclusive board lease → deploy/boot/validation → immutable evidence → Jira → Knox를 하나의 Run과 correlation ID로 묶는 운영 모델이다. 외부 branch는 계약과 Mock으로 이 연결을 검증하고, 사내 final branch는 동일 계약에 실제 adapter와 sanitized evidence를 결합한다.

## 6. 마스코트와 제출 자산

- 원본: 사용 권한이 확인된 PlatformClaw 공식 픽셀 SVG
- 저장 위치: `docs/assets/platformclaw/mascot.svg`
- slide 사본: `submission/slides/assets/platformclaw-mascot.svg`
- 용도: README, offline HTML slide, PlatformClaw UI
- 처리: 비율·투명도·눈·집게·픽셀 형태를 바꾸지 않고, raster rendering 시 `image-rendering: pixelated` 적용
- 금지: 생성형 AI로 다른 외형을 만들거나 기울임·재해석

## 7. 제출 데이터 위생

공식 안내 메일 원본은 이름, 이메일, 전화번호, 부서, Message-ID와 추적 markup을 포함하므로 저장소에 복사하지 않는다. `docs/submission/00_EVALUATION_REQUIREMENTS.md`에는 의미를 유지한 익명 요약만 기록한다. 실제 evidence와 영상에도 개인 정보, secret, internal hostname을 남기지 않는다.
