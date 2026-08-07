# 출처와 개발 범위

## 선언

- 기존 POC는 아이디어 가능성만 확인했다.
- 기존 POC의 source는 현재 저장소에 복사하거나 재사용하지 않았다.
- 현재 PlatformClaw 제품 구현은 해커톤 기간에 개발했다.
- Git ancestry와 법적 고지는 그대로 보존한다.

## Git 이력 근거

| 시점                 | 근거                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| 2026-07-03 이후      | 해커톤 개발 허용 기간 시작 경계                                                               |
| 2026-07-18 10:33 KST | 현재 이력에서 확인한 최초 PlatformClaw 제품 commit `7b58338354708179ae4303363b0c9af0a90e4f92` |
| 2026-08-01           | 확인된 upstream common ancestor `02457657f012d33e141c710d92671d1bc4a519e9`                    |
| 2026-08-06 21:20 KST | 제출 branch baseline `dae6d288c6f0d6e543955c13f73a03967b794e6c`                               |

추적된 PlatformClaw 제품 구현과 fork 기준 이력은 모두 7월 3일 이후다. Git 이력은 현재 저장소의 tracked source 시점을 증명한다. POC 비재사용 선언은 위 개발 범위 선언과 함께 적용한다.

## 기존 POC

POC는 컨셉의 기술적 가능성을 확인하기 위한 별도 실험이었다. 현재 VM 연결, 멀티유저 Control Plane, Sandbox 정책, credential 경계와 Board Farm workflow의 구현 기반이 아니다. POC source와 사내 정보는 제출 저장소에 포함하지 않는다.

상태: `OUT_OF_SCOPE`.

## 외부 기반과 법적 고지

현재 저장소는 [OpenClaw](https://github.com/openclaw/openclaw)의 Git ancestry와 범용 runtime 기반을 보존한다. 호환성 때문에 `@openclaw/*`, Gateway Protocol, Plugin SDK, migration·CLI·session contract 이름이 남아 있다. 저작권과 라이선스는 [LICENSE](LICENSE), dependency 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 보존한다.

## 해커톤 기간 구현

다음 PlatformClaw 제품 영역은 현재 downstream에서 개발·재설계했다.

- enterprise principal, browser session, multi-user authorization
- Personal/Group Agent provisioning과 ownership enforcement
- 개인 개발 VM 연결, code change, build와 target revision
- encrypted SSH/MCP credential envelope와 one-shot broker
- rootless Docker Sandbox 정책
- Knox DM/room routing과 제한된 employee Web surface
- PlatformClaw execution, MCP, admin UI
- restart reconciliation, audit와 deployment smoke
- Board Farm domain contract, deterministic Mock workflow와 submission gates

상세 source mapping은 [코드 지도](docs/submission/12_CODE_MAP.md)와 [평가 map](submission/evaluation-map.yaml)에 있다.

## 사내 자산

실제 Board Farm MCP 연결, 사내 인증·endpoint, Global Skills, Jira·Knox 연결, 실제 보드·VM·정책·측정값은 `INTERNAL_INTEGRATION_REQUIRED`다. 공개 저장소에는 계약, template, acceptance gate와 평가용 sanitized source만 둘 수 있다. credential, private endpoint와 사내 식별자는 포함하지 않는다. 별도 Board Farm MCP repository의 평가 provenance 또는 snapshot은 `submission/external-components/board-farm-mcp/`, 실제 Global Skill source는 `submission/global-skills/`가 소유한다.

## 제출 데이터 위생

공식 안내 원문의 개인 정보와 추적 markup은 저장소에 복사하지 않았다. 실제 evidence와 영상에도 개인 정보, secret, internal hostname을 넣지 않는다.
