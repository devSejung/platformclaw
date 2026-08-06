---
summary: "엔지니어링 workflow 개선 가치와 사내 실측 계획"
read_when:
  - "PlatformClaw 적용처, 파급과 business metric을 검토할 때"
title: "비즈니스 가치"
---

# 비즈니스 가치

## 적용 문제

현재 firmware/SoC workflow는 대화, source, VM, build, Board Farm, Jira와 Knox 사이에서 context와 evidence를 사람이 옮긴다. PlatformClaw는 identity와 Run을 중심으로 이 handoff를 연결하되 personal/group security boundary를 유지한다.

## Workflow 비교

| 단계       | 기존 흐름                         | PlatformClaw 목표 흐름               |
| ---------- | --------------------------------- | ------------------------------------ |
| 요청       | 채팅·ticket에서 수동 해석         | Web/Knox identity와 Agent에 연결     |
| 작업 환경  | 담당자가 VM/Workspace를 찾아 이동 | personal Agent의 명시적 target       |
| credential | 여러 tool에서 재입력·보관 위험    | encrypted vault와 one-shot broker    |
| build      | log와 artifact를 수동 전달        | digest와 result를 Run에 기록         |
| board      | 별도 예약·상태 확인               | build-gated exclusive lease          |
| validation | board log를 수동 수집             | deploy/boot/validate evidence bundle |
| 보고       | Jira 재작성                       | evidence ref를 Jira Skill에 전달     |
| 알림       | 결과를 messenger에 재전송         | sanitized result를 Knox에 전달       |
| 실패       | 어느 단계인지 재구성              | Run/attempt/state/evidence로 진단    |

## 적용처

- firmware change의 build와 실제 board regression 검증
- 팀별 room Agent를 통한 공용 incident/validation workflow
- personal assigned VM이 필요한 legacy toolchain
- 반복적인 Jira evidence 정리와 result notification
- board lease utilization과 failure diagnosis의 운영 가시성

## 기대 가치

- Tool Switching Count와 Human Interaction Count 감소
- onboarding 시 identity/Agent/Workspace 자동 준비
- build 실패 시 불필요한 board 점유 방지
- lease와 evidence owner 명확화
- 실패 원인과 결과의 audit 가능성
- personal/group execution policy의 조직 확장성

이 항목은 구조적 기대이며 실제 개선 수치를 주장하지 않는다. 현재 상태는 `IMPLEMENTED_WITH_LIMITATIONS`; 효과 측정은 `INTERNAL_INTEGRATION_REQUIRED`.

## 측정 계획

같은 난이도의 기존 작업과 actual Golden Run에서 다음을 기록한다.

- End-to-end Time
- Human Interaction Count
- Tool Switching Count
- Retry Count
- Success Rate
- Failure Diagnosis Time
- Onboarding Time
- Hardware Utilization
- Evidence Completeness

baseline 정의, sample 수, 시작/종료 기준과 실패 포함 규칙을 `IR-010`에서 기록한다. 측정 전 숫자를 만들지 않는다.

## 사내 Acceptance

실제 engineer가 Web personal flow를 수행하고, Knox DM과 Group policy를 확인하며, VM code change → build → lease → deploy → boot → validate → Jira → Knox가 한 correlation ID로 연결돼야 한다. 최소 1개 failure/retry proof와 sanitized evidence가 있어야 business value를 actual로 평가할 수 있다.
