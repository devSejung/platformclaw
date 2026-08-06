---
summary: "외부 prep branch에서 사내 final branch로 이어지는 인계 절차"
read_when:
  - "IR-001부터 IR-013까지 사내 최종화를 시작할 때"
title: "사내 인계"
---

# 사내 인계

외부 준비 branch는 `submission/hello-ai-2026-prep`이다. 사내에서는 이 branch를 fetch하고 `submission/hello-ai-2026-final`을 새로 만든다. source에 internal URL, secret, 개인 정보나 raw log를 commit하지 않는다.

## 첫 실행

```bash
git fetch origin
git switch -c submission/hello-ai-2026-final origin/submission/hello-ai-2026-prep
pnpm submission:verify:external
```

## Requirement 순서

| ID       | 작업                          | 주요 대상                                     | 완료 proof                 |
| -------- | ----------------------------- | --------------------------------------------- | -------------------------- |
| `IR-001` | 실제 Board Farm MCP adapter   | Control Plane board-farm adapter registration | contract tests             |
| `IR-002` | Board Farm auth/Tool/endpoint | deployment secret/config                      | readiness + tool mapping   |
| `IR-003` | Global Skill baseline         | managed skill root                            | version/provenance         |
| `IR-004` | Firmware Build Skill          | global skill                                  | actual artifact digest     |
| `IR-005` | Board Validation Skill        | global skill                                  | boot/validation result     |
| `IR-006` | Jira Report Skill             | global skill                                  | issue result               |
| `IR-007` | Knox Result delivery          | result notification + CDEP                    | delivery ID                |
| `IR-008` | 내부 policy/docs              | deployment and docs                           | sanitized review           |
| `IR-009` | actual Golden Run             | `actual-golden-run/`                          | Web/DM/Group/VM/board flow |
| `IR-010` | actual evidence/metrics       | manifest + metrics                            | measured values            |
| `IR-011` | MP4                           | `submission/video/`                           | <=5m metadata              |
| `IR-012` | internal final validation     | final gate                                    | all green                  |
| `IR-013` | final Git state               | branch/commit/push/tag                        | remote confirmation        |

정확한 checkbox, target file, secret input, command, expected result, failure location, evidence와 gate는 `submission/INTERNAL_FINALIZATION_CHECKLIST.md`에 있다.

## Secret 입력

secret 값은 repository file이나 shell history에 직접 기록하지 않는다. deployment-owned secret file 또는 approved secret mount를 사용하고 source에는 `*_FILE` reference만 둔다. acceptance output은 secret value를 print하지 않아야 한다.

## Actual evidence

actual file은 `submission/evidence/actual-golden-run/`에만 둔다. user/resource는 alias를 사용하고 screenshot/log에서 name, employee ID, department, email, phone, internal hostname, token/cookie/key를 마스킹한다. 각 result는 source commit, Run/correlation ID, timestamp, command, artifact digest, status와 evidence ref를 가진다.

## 상태 승격

`INTERNAL_INTEGRATION_REQUIRED`를 변경하기 전에 code, test와 actual evidence가 모두 있어야 한다. `evaluation-map.yaml`, README, EVALUATION, slide를 같은 commit에서 갱신하고 `pnpm submission:verify:final`을 실행한다. Mock path를 actual evidence field에 넣지 않는다.
