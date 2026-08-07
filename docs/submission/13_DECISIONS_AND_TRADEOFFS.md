---
summary: "PlatformClaw package, policy, credential와 evidence 설계 선택"
read_when:
  - "선택한 architecture와 제외한 대안을 검토할 때"
title: "Architecture 결정과 Trade-off"
---

# Architecture 결정과 Trade-off

## Fresh downstream, wholesale migration 아님

Legacy POC를 복사하지 않고 OpenClaw ancestry를 유지한 fresh downstream에 capability를 하나씩 배치했다. 기존 POC의 빠른 재사용보다 upstream sync와 owner boundary를 우선했다.

## Generic core와 private plugin

enterprise identity/state는 Control Plane이, runtime-specific VM/MCP/Knox는 plugins가 소유한다. OpenClaw core에 bundled ID와 enterprise policy를 흩뿌리는 대안을 제외했다. 이 선택은 일부 adapter code를 추가하지만 upstream divergence를 줄인다.

## Board Farm 위치

`packages/platformclaw-control-plane/src/board-farm/`을 선택했다.

- Mock lease state가 Run/user/Agent ownership과 correlation을 공유
- existing Control Plane test/build/SQLite direction에 자연스럽게 포함
- domain contract와 MCP adapter를 분리 가능
- 아직 독립 package lifecycle·version이 필요한 근거가 부족

### Existing-solution preflight

- [labgrid](https://labgrid.readthedocs.io/en/latest/overview.html)는 coordinator/place 기반 mutual exclusion과 resource reservation을 제공하므로 실제 lease adapter 후보로 재사용할 수 있다.
- [LAVA scheduler](https://lava.readthedocs.io/en/latest/technical-references/services/lava-scheduler/)는 device job scheduling을 제공하므로 사내 Board Farm의 실행 backend 후보로 재사용할 수 있다.
- [OpenHTF](https://github.com/google/openhtf)는 test phase, measurement와 attachment를 제공하므로 validation/evidence adapter 후보로 재사용할 수 있다.

PlatformClaw의 custom 범위는 이 도구들을 대체하는 scheduler나 test framework가 아니다. authenticated user ownership, 개인 개발 VM 접속, correlation/evidence와 Jira/Knox handoff를 하나의 Control Plane contract로 소유하고, 실제 Board Farm lease/control은 MCP boundary 뒤에 연결하는 부분이다.

`packages/platformclaw-board-farm/` 대안은 독립 배포·storage owner가 생길 때 재검토한다. 지금 분리하면 persistence와 authorization을 중복시킬 위험이 있다.

## VM과 Sandbox

personal Agent는 approved assigned VM을 선택할 수 있지만, Basic과 Group은 rootless Docker policy를 따른다. VM 장애 시 server로 자동 fallback하지 않는다. 편의성보다 실행 위치의 설명 가능성과 credential boundary를 우선했다.

## Personal과 Group

Group room은 개인 Agent/VM/credential을 재사용하지 않는다. linked participant의 개인 환경을 활용하는 대안은 UX가 쉬워 보이지만 room participant와 personal owner 경계를 깨므로 제외했다.

## Credential

encrypted SQLite envelope + deployment master key + one-shot local broker를 사용한다. config/env에 원문을 두거나 Gateway가 master key를 가지는 대안을 제외했다. rotation 시 active requester/lease를 invalidate하는 비용을 감수한다.

## Global Skill

global skill은 administrator-owned versioned artifact이고 Run은 immutable snapshot을 사용한다. run 중 자동 refresh나 user global write를 제외했다. 재현성과 provenance를 우선한다.

## MCP

global server registry는 administrator가 소유하고 personal credential만 사용자별로 저장한다. 개인이 arbitrary endpoint를 등록하는 대안을 제외해 SSRF와 policy surface를 제한했다.

## Mock와 Actual

deterministic Mock는 closed-loop shape와 최소 owner/lifecycle 불변식을 검증하지만 actual MCP의 exact contract를 대신하지 않는다. `mode: mock`, 별도 directory와 final gate로 actual과 분리하며, 외부에서 내부 시스템을 흉내 낸 결과를 production proof로 표현하는 대안을 명시적으로 금지한다.

## OpenClaw surface

consumer channels/apps를 wholesale 삭제하지 않고 `RETAIN_BUT_HIDDEN`으로 분류했다. workspace/catalog/upstream sync closure를 깨지 않으면서 README, login, navigation, slide와 demo의 제품 초점을 PlatformClaw로 바꾼다.

## Positive trade-off summary

추가되는 코드와 문서는 새로운 capability, security owner, 내부 contract 또는 submission evidence gate를 소유해야 한다. 단순 wrapper, fallback stack과 상태 중복은 만들지 않는다.
