---
summary: "PlatformClaw Global Skills의 ownership, snapshot과 failure 계약"
read_when:
  - "사내 Build, Validation, Jira, Notification Skill을 연결할 때"
title: "Global Skills 정책"
---

# Global Skills 정책

## 상태

실제 PlatformClaw Global Skill 설치·구현과 사내 Build/Validation/Jira/Notification Skill 연결은 `INTERNAL_INTEGRATION_REQUIRED`(`IR-003`~`IR-007`)이다. 외부 branch에는 contract와 acceptance template만 둔다.

## Ownership

- administrator: global skill source, version, provenance, dependency와 secret policy
- user: 자신의 Workspace skill
- assigned VM image: `/opt/platformclaw/bundle` built-in skill
- global managed root: `/opt/platformclaw/skills`
- Agent Run: start 시 immutable skill snapshot

사용자는 global skill을 변경하거나 관리자 credential을 볼 수 없다. Group Agent에는 approved global skill만 제공하고 personal skill·credential을 섞지 않는다.

## Required Skills

| Skill                        | Requirement | 입력                                   | 출력                              | Secret               |
| ---------------------------- | ----------- | -------------------------------------- | --------------------------------- | -------------------- |
| PlatformClaw Global baseline | `IR-003`    | Run context                            | bounded common tools              | none/declared        |
| Firmware Build               | `IR-004`    | source revision, target, build profile | artifact digest, log refs, result | build service mount  |
| Board Validation             | `IR-005`    | lease, artifact, profile               | observations, pass/fail, evidence | Board adapter only   |
| Jira Report                  | `IR-006`    | Run summary, evidence refs             | issue key/url alias, result       | Jira connector mount |
| Result Notification          | `IR-007`    | sanitized summary, report ref          | delivery ID/result                | Knox service mount   |

## Run Snapshot

Run start에서 target revision, skill name/version/digest/provenance와 eligibility를 기록한다. explicit refresh는 다음 Run에 적용되고 현재 Run을 바꾸지 않는다. assigned VM remote scan은 bounded output과 entry count를 강제하며 partial truncation을 성공으로 처리하지 않는다.

근거: `extensions/platformclaw-execution/src/remote-skills.ts`, `remote-skills.test.ts`.

## Failure contract

- missing/unavailable skill: Run 전 fail closed, enablement/설치 경로 제시
- build failure: Board Farm 호출 금지
- validation failure: evidence 보존
- Jira/notification failure: Run 상태와 prior evidence 보존, retry 가능한 결과
- version/digest mismatch: actual evidence gate 실패

## Acceptance

각 template의 `ACCEPTANCE_TESTS.md`를 통과하고, source path·version·digest·owner를 actual manifest에 기록한다. secret은 environment value가 아니라 file/mount reference로 주입한다.
