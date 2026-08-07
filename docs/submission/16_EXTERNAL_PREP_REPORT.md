---
summary: "외부 prep branch의 다섯 review pass, 수정과 남은 제한"
read_when:
  - "외부 제출 준비에서 검토한 내용과 사내 잔여 작업을 확인할 때"
title: "외부 준비 Review Report"
---

# 외부 준비 Review Report

이 문서는 external prep branch에서 수행한 독립 review pass와 수정 결과를 기록한다. chain-of-thought나 개인 정보는 기록하지 않는다.

## Pass 1 — 기술성

- 발견: Board Farm actual integration과 Mock contract를 같은 완료 상태로 표현할 위험
- 수정: Mock lifecycle과 actual MCP lease/control boundary, `MOCK_VERIFIED`, `IR-001`·`IR-002` 명시
- 발견: browser UI hiding이 authorization으로 오인될 위험
- 수정: request/result/event의 server owner check를 보안 문서와 architecture에 연결
- 발견: 재시작 시 불완전하거나 조작된 Board Farm snapshot이 canonical state로 유입될 수 있는 신뢰 경계
- 수정: run·lease·resource·evidence·audit·idempotency의 timestamp, digest, 참조와 상태 정합성을 전수 검증하고 malformed snapshot 회귀 테스트 추가

## Pass 2 — 창의성

- 발견: OpenClaw fork 재브랜딩으로 보일 위험
- 수정: fresh upstream, 해커톤 신규 enterprise boundary, Legacy POC와 internal asset을 ATTRIBUTION에서 분리
- 발견: hardware closed loop의 신규 가치가 추상적
- 수정: Run, target revision, artifact digest, lease, evidence, report/notification의 연결을 diagram과 contract로 구체화

## Pass 3 — 완성도

- 발견: actual evidence와 video가 없는 외부 상태를 과장할 위험
- 수정: Mock/Actual directory, manifest mode와 final gate를 분리하고 actual 항목을 `INTERNAL_INTEGRATION_REQUIRED`로 표시
- 발견: error/retry/cleanup 설명 분산
- 수정: `09_OPERATIONS_FAILURE_RECOVERY.md`에 owner와 visible outcome matrix 구성
- 발견: 한국어 Windows의 system locale이 영어 내비게이션 테스트 기대값에 누출되고, HTTP fixture가 브라우저 금지 포트를 받을 수 있음
- 수정: 내비게이션 테스트 locale을 명시하고 HTTP fixture를 deterministic safe-port allocator에 연결
- 발견: JSON-compatible YAML을 일반 YAML formatter가 JSONC trailing comma 형태로 바꾸는 parser/formatter 불일치
- 수정: 두 canonical map을 strict JSON으로 복구하고 `.oxfmtrc.jsonc`에서 명시적으로 제외

## Pass 4 — 비즈니스 가치

- 발견: 시간 절감 수치의 실측 근거 없음
- 수정: 숫자를 제거하고 9개 측정 항목, baseline 규칙과 `IR-010`을 연결
- 발견: 사내 적용 flow가 단계별 tool에 머묾
- 수정: 기존/목표 workflow와 owner/evidence 관점 비교

## Pass 5 — 전달력

- 발견: 기존 README가 OpenClaw consumer assistant 중심
- 수정: PlatformClaw 3분 funnel, local mascot, 상태 표, Golden Path와 attribution으로 교체
- 발견: 공식 메일 원문에 PII와 tracking markup 포함
- 수정: 원문은 commit하지 않고 `00_EVALUATION_REQUIREMENTS.md`에 익명 의미·비중·anchor만 보존

## 실행한 확인

- repository/scoped `AGENTS.md`, `PLATFORMCLAW.md`, relevant `docs/platformclaw/**` 확인
- Control Plane, execution, Knox, MCP, UI와 Docker source/test path inventory
- 공식 안내의 제출물, 5개 비중, 1·3·5 anchor, independent/blind/evidence/injection 규칙 대조
- 문서의 internal work를 `IR-001`~`IR-013`으로 중앙화

## 검증 결과

external prep의 현재 source와 artifact를 대상으로 다음 결과를 확인했다.

| 확인                                             | 결과                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `node scripts/submission/verify-external.mjs`    | PASS — 32개 필수 문서, 19개 평가 claim, 13개 내부 requirement, offline slide, blindness와 5개 review pass |
| `node scripts/check-docs-mdx.mjs docs README.md` | PASS — 798 files                                                                                          |
| `node scripts/docs-link-audit.mjs`               | PASS — 6,376 internal links, broken 0                                                                     |
| `node scripts/docs-list.js`                      | PASS — `docs/submission/**` front matter 확인                                                             |
| Control Plane focused suite                      | PASS — 50 files, 355 passed, 5 intentional skipped                                                        |
| PlatformClaw UI focused suite                    | PASS — 6 files, 112 passed                                                                                |
| CI planner/submission tooling suite              | PASS — 4 files, 40 passed                                                                                 |
| Control Plane·Control UI build                   | PASS — declaration 포함 Control Plane build와 2개 UI production build                                     |
| Mock Golden Path                                 | PASS — `golden-run-000001`, deploy·boot·validate·cleanup evidence 4건                                     |
| actionlint 1.7.12·zizmor 1.28.0                  | PASS — submission workflow finding 0                                                                      |
| Docker Compose config                            | PASS — jammy와 runtime+smoke 조합                                                                         |
| PlatformClaw image build·runtime Docker smoke    | PASS — Ubuntu 22.04, Node 24, 격리 sandbox, 로그인·RBAC·SafeConnect·VM·재시작·secret non-leak             |
| targeted `oxfmt --check`                         | PASS — 제출 문서 38 files                                                                                 |
| changed-source `oxlint`                          | PASS — type-aware, warning 0                                                                              |
| `git diff --check`                               | PASS                                                                                                      |
| `node scripts/submission/verify-final.mjs`       | EXPECTED FAIL — 13개 내부 requirement가 의도대로 final 제출을 차단                                        |

Windows linked worktree 안전 규칙 때문에 `pnpm docs:list`가 dependency bootstrap을 시도하는 경로는 사용하지 않고, 같은 목록 script를 `node scripts/docs-list.js`로 직접 실행했다. 전체 docs formatter wrapper는 Windows command-line 길이 제한을 만나 제출 범위를 targeted `oxfmt --check`로 검증했다. Docker runtime smoke의 최초 호출은 WSL host Node 18이 Node 22+ 전용 build helper를 읽어 실패했지만, 이미 검증된 이미지를 재사용하도록 skip 변수를 WSL shell 안에서 설정한 동일 smoke를 재실행해 통과했다. 이미지 내부 권위 런타임은 Node 24.18.0이다.

자동 autoreview는 secret scan을 통과했지만 전체 변경 bundle이 허용 입력보다 커 diff 절단을 거부했다. 이를 성공으로 간주하지 않았고 위 다섯 pass, 전체 변경 파일 inventory, 직접 lint·test·build·evidence 검증으로 대체했다. 로컬 `platformclaw-check --quick`의 tsgo 단계는 변경되지 않은 `packages/terminal-core/src/ansi.ts:194`와 재사용 Windows toolchain의 dependency signature 차이로 중단됐다. Control Plane declaration build와 type-aware oxlint는 통과했으며, clean Linux `pnpm check:changed` proof는 원격 Testbox가 이 downstream origin을 해석하지 못해 원격 CI 항목으로 남긴다. 추가 UI E2E 재실행은 Windows Playwright Chromium의 `--version` probe가 종료되지 않은 뒤 의존성 재설치를 시도해 linked-worktree 안전 규칙상 중단됐다. UI 단위 경로 112개와 production build는 통과했으며 수동 fixture screenshot은 별도 검토했다; 이 E2E 재실행을 통과로 계산하지 않는다.

## 남은 제한

- 실제 Board Farm, internal Skills, Jira와 Knox delivery: `IR-001`~`IR-007`
- internal policy/data와 actual Golden Run/evidence/metrics: `IR-008`~`IR-010`
- MP4, final validation, branch/commit/push/tag: `IR-011`~`IR-013`

외부 제출 준비 게이트는 통과한다. 최종 제출 게이트는 actual evidence와 사내 통합을 완료해 13개 requirement를 `VERIFIED_IMPLEMENTED`로 전환하기 전까지 통과해서는 안 된다.
