---
summary: "5분 이내 PlatformClaw actual demo의 화면, narration과 masking 계획"
read_when:
  - "사내에서 최종 MP4를 rehearsal하거나 녹화할 때"
title: "5분 Demo 계획"
---

# 5분 Demo 계획

실제 MP4는 사내에서 녹화한다. 총 길이는 5분을 넘지 않으며 권장 목표는 4분 50초다.

| 시간      | 화면                          | Narration 핵심                                | 필요한 evidence      |
| --------- | ----------------------------- | --------------------------------------------- | -------------------- |
| 0:00–0:25 | 기존 tool 전환 diagram        | 요청부터 board/Jira/Knox까지 흩어진 문제      | slide 2              |
| 0:25–0:45 | PlatformClaw closed loop      | identity와 Run으로 연결                       | architecture flow    |
| 0:45–1:15 | Login, Personal Agent         | opaque session, idempotent Agent/Workspace    | sanitized login      |
| 1:15–1:45 | Execution Settings            | Basic/assigned VM과 target 표시               | VM readiness         |
| 1:45–2:20 | source change와 build         | artifact digest, build fail gate              | build result         |
| 2:20–3:15 | lease, deploy, boot, validate | exclusive lease와 hardware evidence           | board results        |
| 3:15–3:50 | evidence와 Jira               | Run-linked report, failure 보존               | manifest, Jira       |
| 3:50–4:15 | Knox result                   | sanitized visible outcome                     | delivery proof       |
| 4:15–4:40 | User B deny, Group Room       | tenant isolation, personal VM/credential 금지 | denial + room target |
| 4:40–5:00 | business와 scope              | 측정값, 외부 기반 출처, 남은 제한 없음        | metric + attribution |

## 화면 순서

1. title/mascot
2. login
3. identity·Agent·Workspace
4. Execution Target
5. source diff
6. build status
7. board lease/resource alias
8. deploy/boot/validation
9. evidence manifest
10. Jira result
11. Knox result
12. cross-user denial
13. Group Room Sandbox policy
14. measured metrics와 attribution

## Capture 규칙

- 1920×1080 권장, browser zoom 고정
- 실제 화면에는 `ACTUAL`, fallback Mock 화면에는 `MOCK` 표시
- name, employee number, department, email, phone, internal hostname, IP, secret, token, cookie, API key 마스킹
- log는 Run ID alias, 단계와 result만 남기고 debug noise 제거
- cursor와 narration이 화면 전환보다 앞서지 않게 rehearsal

## Narration 원칙

실제 동작과 제한을 함께 말한다. 외부 기반, POC 비재사용과 해커톤 신규 범위를 숨기지 않는다. 점수나 심사자 행동을 요청하지 않는다. 측정하지 않은 숫자를 말하지 않는다.

## Backup

각 live 단계에 같은 source commit의 sanitized screenshot과 짧은 recorded clip을 준비한다. 실패 시 screen capture를 숨기지 말고 backup 화면으로 전환하며 actual run ID와 evidence가 일치하는지 확인한다.

## 재촬영 기준

- 5:00 초과
- 개인 정보·secret·internal hostname 노출
- Mock를 Actual로 잘못 표시
- Run/correlation ID 불일치
- 핵심 단계 누락
- unreadable text, 잘린 UI, error state 방치
- narration과 화면 결과 불일치
